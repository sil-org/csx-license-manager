-- Run this in the Supabase SQL Editor.
--
-- Duplicate-request check was keyed on (user, license, fy) for every license,
-- so a one-time license (e.g. Google Backup, imported under an earlier FY)
-- could be requested again in a later fiscal year. For billing_cycle =
-- 'one_time', any live subscription (pending/approved/active, any FY) now
-- blocks a new request; annual/monthly licenses stay per fiscal year.
-- Still bypassed by licenses.allow_multiple_per_person.
--
-- Body is 80_free_billing_type.sql's request_subscription() with only the
-- duplicate check changed. Same 9-arg signature, so no overload is left behind.
-- Safe to re-run.

create or replace function request_subscription(
  p_license_id uuid,
  p_suite_key text,
  p_suggested_approver_email text,
  p_ministry_id text,
  p_fy int,
  p_recipient_email text default null,
  p_acknowledged boolean default false,
  p_extra_field_value text default null,
  p_suggested_approver_is_group boolean default false
) returns uuid language plpgsql security definer as $$
declare
  v_license licenses%rowtype;
  v_actor_email text := current_profile_email();
  v_recipient_email text := coalesce(nullif(trim(lower(p_recipient_email)), ''), current_profile_email());
  v_sub_id uuid;
  v_status subscription_status;
  v_billing_type subscription_billing_type;
  v_suite_key text := null;
  v_ministry_id text := null;
  v_audit_suite_key text;
  v_canonical_key text;
  v_owner text;
  v_owner_group text;
  v_pending_approver text := null;
  v_is_group boolean := false;
  v_sco text;
  v_price_at_signup numeric;
begin
  if v_actor_email is null then raise exception 'not authenticated'; end if;
  if not is_eligible_staff_email(v_recipient_email) then
    raise exception 'License requests are only available to SIL staff.';
  end if;

  select * into v_license from licenses where id = p_license_id and active;
  if v_license.id is null then raise exception 'license not found or inactive'; end if;
  v_price_at_signup := v_license.price;

  if v_license.requires_acknowledgement and not coalesce(p_acknowledged, false) then
    raise exception 'you must acknowledge the terms & conditions for this license before requesting it';
  end if;

  if v_license.extra_field_required and nullif(trim(p_extra_field_value), '') is null then
    raise exception '% is required for this license', coalesce(v_license.extra_field_label, 'this field');
  end if;

  -- One-time licenses are bought once, so any live subscription (any FY)
  -- blocks a new request. Recurring licenses are per fiscal year: a live
  -- subscription only blocks a request for the same FY.
  if not v_license.allow_multiple_per_person then
    if v_license.billing_cycle = 'one_time' and exists (
      select 1 from subscriptions
      where user_email = v_recipient_email and license_id = p_license_id
        and status not in ('declined', 'revoked', 'cancelled')
    ) then
      raise exception 'you already have this license; it is a one-time purchase and cannot be requested again';
    end if;

    if exists (
      select 1 from subscriptions
      where user_email = v_recipient_email and license_id = p_license_id and fy = p_fy
        and status not in ('declined', 'revoked', 'cancelled')
    ) then
      raise exception 'a subscription for this license already exists for this fiscal year';
    end if;
  end if;

  if v_license.gtis_sponsored then
    v_billing_type := 'gtis';
    v_audit_suite_key := 'GTIS';
    v_status := 'approved';

  elsif v_license.department_gated then
    v_billing_type := 'free';
    select sco into v_sco from profiles where lower(primary_email) = v_recipient_email;
    if v_sco is not null then
      select approver_email into v_pending_approver
      from department_approvals where license_id = p_license_id and sco = v_sco;
    end if;
    v_audit_suite_key := 'DEPT:' || coalesce(v_sco, 'none');
    if v_pending_approver is not null then
      v_status := 'pending';
    else
      v_pending_approver := null;
      v_status := 'approved';
    end if;

  elsif p_ministry_id is not null then
    if p_ministry_id !~ '^\d{6}$' then
      raise exception 'ministry ID must be exactly 6 digits';
    end if;
    v_billing_type := 'ministry';
    v_ministry_id := p_ministry_id;
    v_audit_suite_key := 'MIN:' || p_ministry_id;
    insert into ministry_ids (email, ministry_id) values (v_recipient_email, p_ministry_id)
      on conflict (email) do update set ministry_id = excluded.ministry_id;
    v_status := 'approved';

  else
    v_billing_type := 'suite_key';
    if p_suite_key is null then raise exception 'a suite key is required'; end if;
    v_suite_key := regexp_replace(trim(p_suite_key), '~.*$', '');
    if v_suite_key = '' then raise exception 'a suite key is required'; end if;

    select suite_key, owner_email, owner_group_email into v_canonical_key, v_owner, v_owner_group
    from suite_keys where lower(suite_key) = lower(v_suite_key);
    if v_canonical_key is not null then
      v_suite_key := v_canonical_key;
    end if;
    v_audit_suite_key := v_suite_key;

    if v_canonical_key is null then
      insert into suite_keys (suite_key, owner_email) values (v_suite_key, null);
      v_owner := null;
      v_owner_group := null;
    end if;

    v_price_at_signup := get_area_discounted_price(p_license_id, v_suite_key);

    if v_owner_group is not null then
      if exists (
        select 1 from group_memberships where group_email = v_owner_group and lower(member_email) = lower(v_actor_email)
      ) then
        v_status := 'approved';
      else
        v_status := 'pending';
      end if;

    elsif v_owner is null then
      if p_suggested_approver_email is null then
        raise exception 'suite key % has no owner on file — provide a suggested approver email', v_suite_key;
      end if;
      v_pending_approver := nullif(lower(trim(p_suggested_approver_email)), '');
      if v_pending_approver = lower(v_actor_email) then
        update suite_keys set owner_email = lower(v_actor_email) where suite_key = v_suite_key;
        insert into audit_log (action, suite_key, performed_by, ip_address)
        values ('sk_verified', v_suite_key, v_actor_email, current_client_ip());
        v_status := 'approved';
        v_pending_approver := null;
      else
        v_status := 'pending_sk_verification';
        v_is_group := coalesce(p_suggested_approver_is_group, false);
      end if;
    elsif lower(v_owner) = lower(v_actor_email) then
      v_status := 'approved';
    else
      v_status := 'pending';
    end if;
  end if;

  insert into subscriptions (
    user_email, license_id, suite_key, billing_type, ministry_id, fy, status, billing_cycle,
    renewal_month, renewal_reminder, price_at_signup, pending_approver_email, pending_approver_is_group, requested_by, extra_field_value
  ) values (
    v_recipient_email, p_license_id, v_suite_key, v_billing_type, v_ministry_id, p_fy, v_status, v_license.billing_cycle,
    v_license.renewal_month, v_license.renewal_reminder, v_price_at_signup, v_pending_approver, v_is_group, current_profile_id(),
    nullif(trim(p_extra_field_value), '')
  ) returning id into v_sub_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
  values (
    'requested', v_sub_id, v_license.name, v_recipient_email, v_audit_suite_key, v_actor_email,
    nullif(trim(concat_ws(
      '; ',
      case when v_recipient_email <> v_actor_email then 'on behalf of ' || v_recipient_email else null end,
      case when v_license.requires_acknowledgement then 'acknowledged terms & conditions' else null end
    )), ''),
    current_client_ip()
  );

  if v_status = 'approved' then
    insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, ip_address)
    values ('auto_approved', v_sub_id, v_license.name, v_recipient_email, v_audit_suite_key, v_actor_email, current_client_ip());
  end if;

  return v_sub_id;
end;
$$;

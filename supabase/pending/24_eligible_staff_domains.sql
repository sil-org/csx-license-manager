-- "SIL staff" was hardcoded as "@sil.org" in two places, which is wrong —
-- SIL staff includes people on a handful of other SIL-affiliated domains
-- (mirrors gas-legacy's ALLOWED_DOMAINS in Code.gs). This was surfacing as
-- the "License requests are only available to SIL staff (sil.org
-- accounts)." message shown to eligible staff on a non-sil.org address.
--
-- Run supabase/schema.sql AGAIN first (it's idempotent) — it now defines
-- is_eligible_staff_email(), which this file's copy of request_subscription()
-- depends on, and it also loosens the resolve_profile() sign-in gate the
-- same way. schema.sql is shared with the helpdesk app's repo — copy the
-- updated file over there too so the two stay in sync (they share the same
-- Supabase project, so whichever copy of resolve_profile() ran last wins).

create or replace function request_subscription(
  p_license_id uuid,
  p_suite_key text,
  p_suggested_approver_email text,
  p_ministry_id text,
  p_fy int,
  p_recipient_email text default null
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
begin
  if v_actor_email is null then raise exception 'not authenticated'; end if;
  if not is_eligible_staff_email(v_recipient_email) then
    raise exception 'License requests are only available to SIL staff.';
  end if;

  select * into v_license from licenses where id = p_license_id and active;
  if v_license.id is null then raise exception 'license not found or inactive'; end if;

  if exists (
    select 1 from subscriptions
    where user_email = v_recipient_email and license_id = p_license_id and fy = p_fy
      and status not in ('declined', 'revoked', 'cancelled')
  ) then
    raise exception 'a subscription for this license already exists for this fiscal year';
  end if;

  if v_license.gtis_sponsored then
    v_billing_type := 'gtis';
    v_audit_suite_key := 'GTIS';
    v_status := case when v_license.activation_url is not null then 'approved' else 'active' end;

  elsif p_ministry_id is not null then
    if p_ministry_id !~ '^\d{6}$' then
      raise exception 'ministry ID must be exactly 6 digits';
    end if;
    v_billing_type := 'ministry';
    v_ministry_id := p_ministry_id;
    v_audit_suite_key := 'MIN:' || p_ministry_id;
    insert into ministry_ids (email, ministry_id) values (v_recipient_email, p_ministry_id)
      on conflict (email) do update set ministry_id = excluded.ministry_id;
    v_status := case when v_license.activation_url is not null then 'approved' else 'active' end;

  else
    v_billing_type := 'suite_key';
    if p_suite_key is null then raise exception 'a suite key is required'; end if;
    v_suite_key := trim(p_suite_key);
    if v_suite_key like '%~%' then
      raise exception 'SuiteKey cannot contain "~" — check for stray text pasted in after the real key';
    end if;

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

    if v_owner_group is not null then
      if exists (
        select 1 from group_memberships where group_email = v_owner_group and member_email = v_actor_email
      ) then
        v_status := case when v_license.activation_url is not null then 'approved' else 'active' end;
      else
        v_status := 'pending';
      end if;

    elsif v_owner is null then
      if p_suggested_approver_email is null then
        raise exception 'suite key % has no owner on file — provide a suggested approver email', v_suite_key;
      end if;
      v_status := 'pending_sk_verification';
      v_pending_approver := p_suggested_approver_email;
    elsif v_owner = v_actor_email then
      v_status := case when v_license.activation_url is not null then 'approved' else 'active' end;
    else
      v_status := 'pending';
    end if;
  end if;

  insert into subscriptions (
    user_email, license_id, suite_key, billing_type, ministry_id, fy, status, activated_at, billing_cycle,
    renewal_month, renewal_reminder, price_at_signup, pending_approver_email, requested_by
  ) values (
    v_recipient_email, p_license_id, v_suite_key, v_billing_type, v_ministry_id, p_fy, v_status,
    case when v_status = 'active' then current_date else null end, v_license.billing_cycle,
    v_license.renewal_month, v_license.renewal_reminder, v_license.price, v_pending_approver, current_profile_id()
  ) returning id into v_sub_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
  values (
    'requested', v_sub_id, v_license.name, v_recipient_email, v_audit_suite_key, v_actor_email,
    case when v_recipient_email <> v_actor_email then 'on behalf of ' || v_recipient_email else null end,
    current_client_ip()
  );

  if v_status in ('active', 'approved') then
    insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, ip_address)
    values ('auto_approved', v_sub_id, v_license.name, v_recipient_email, v_audit_suite_key, v_actor_email, current_client_ip());
  end if;

  return v_sub_id;
end;
$$;

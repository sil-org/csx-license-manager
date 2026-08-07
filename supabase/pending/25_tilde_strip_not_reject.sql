-- Run this in the Supabase SQL Editor.
--
-- Fixes a mistake in 09_merge_status_fix_and_tilde_guard.sql: a SuiteKey
-- containing "~" (garbage pasted in after the real key, e.g.
-- "Relations-U_SIL~5407") should have the "~" and everything after it
-- ignored, not be rejected outright. admin_import_subscriptions_full()
-- already did this correctly (regexp_replace(..., '~.*$', '')) — this makes
-- request_subscription(), admin_update_suite_key_owner(), and
-- admin_import_subscriptions() match it instead of raising an exception.

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
    -- Anything from "~" onward is stray pasted text, not part of the real
    -- key (e.g. "Relations-U_SIL~5407") — ignore it rather than rejecting
    -- the whole entry, same as admin_import_subscriptions_full() already
    -- does for legacy data.
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

create or replace function admin_update_suite_key_owner(
  p_suite_key text, p_new_owner_email text, p_description text default null, p_owner_group_email text default null
) returns table(id uuid, user_email text, license_name text)
language plpgsql security definer as $$
declare
  v_owner text := nullif(lower(trim(p_new_owner_email)), '');
  v_group text := nullif(lower(trim(p_owner_group_email)), '');
  v_canonical_key text;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  -- Anything from "~" onward is stray pasted text, not part of the real key
  -- (e.g. "Relations-U_SIL~5407") — ignore it rather than rejecting the
  -- whole entry, same as request_subscription().
  p_suite_key := regexp_replace(trim(p_suite_key), '~.*$', '');
  if p_suite_key = '' then raise exception 'suite key is required'; end if;
  if v_owner is not null and v_group is not null then
    raise exception 'a suite key can have an individual owner or a group owner, not both';
  end if;

  select suite_key into v_canonical_key from suite_keys where lower(suite_key) = lower(p_suite_key);
  if v_canonical_key is not null then
    p_suite_key := v_canonical_key;
  end if;

  insert into suite_keys (suite_key, owner_email, owner_group_email, description)
  values (p_suite_key, v_owner, v_group, p_description)
  on conflict (suite_key) do update
    set owner_email = v_owner,
        owner_group_email = v_group,
        description = coalesce(p_description, suite_keys.description);

  if v_group is not null then
    return query
      update subscriptions s
      set status = 'pending', pending_approver_email = null
      from licenses l
      where s.suite_key = p_suite_key and s.status = 'pending_sk_verification' and l.id = s.license_id
      returning s.id, s.user_email, l.name;
  elsif v_owner is not null then
    return query
      update subscriptions s
      set pending_approver_email = v_owner
      from licenses l
      where s.suite_key = p_suite_key and s.status = 'pending_sk_verification' and l.id = s.license_id
      returning s.id, s.user_email, l.name;
  end if;
end;
$$;

create or replace function admin_import_subscriptions(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_admin text := current_profile_email();
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_user_email text;
  v_license_name text;
  v_raw_suite_key text;
  v_start_date date;
  v_fy int;
  v_license licenses%rowtype;
  v_billing_type subscription_billing_type;
  v_suite_key text;
  v_ministry_id text;
  v_canonical_key text;
  v_sub_id uuid;
  v_error text;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_error := null;
      v_user_email := lower(trim(v_row->>'user_email'));
      v_license_name := trim(v_row->>'license_name');
      -- Anything from "~" onward is stray pasted text, not part of the real
      -- key (e.g. "Relations-U_SIL~5407") — ignore it rather than rejecting
      -- the row, same as admin_import_subscriptions_full() already does.
      v_raw_suite_key := regexp_replace(trim(coalesce(v_row->>'suite_key', '')), '~.*$', '');
      v_billing_type := null;
      v_suite_key := null;
      v_ministry_id := null;
      v_license := null;

      if v_user_email = '' or v_user_email is null then
        v_error := 'Missing email';
      elsif v_user_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
        v_error := 'Invalid email';
      elsif v_license_name = '' or v_license_name is null then
        v_error := 'Missing license name';
      end if;

      if v_error is null then
        select * into v_license from licenses where lower(name) = lower(v_license_name) and active;
        if v_license.id is null then
          v_error := 'License not found in catalog: ' || v_license_name;
        end if;
      end if;

      if v_error is null then
        v_start_date := nullif(v_row->>'start_date', '')::date;
        if v_start_date is null then v_start_date := current_date; end if;

        if v_row->>'fy' is not null and (v_row->>'fy') != '' then
          v_fy := (v_row->>'fy')::int;
        else
          v_fy := extract(year from v_start_date)::int + (case when extract(month from v_start_date) >= 10 then 1 else 0 end);
        end if;

        if v_license.gtis_sponsored and v_raw_suite_key = '' then
          v_billing_type := 'gtis';
        elsif v_raw_suite_key ~ '^\d{6}$' or v_raw_suite_key ~* '^MIN:\d{6}$' then
          v_ministry_id := regexp_replace(v_raw_suite_key, '^MIN:', '', 'i');
          v_billing_type := 'ministry';
        elsif v_raw_suite_key = '' then
          v_error := 'Missing SuiteKey or Ministry ID';
        else
          v_billing_type := 'suite_key';
          select suite_key into v_canonical_key from suite_keys where lower(suite_key) = lower(v_raw_suite_key);
          v_suite_key := coalesce(v_canonical_key, v_raw_suite_key);
          if v_canonical_key is null then
            insert into suite_keys (suite_key, owner_email) values (v_suite_key, null);
          end if;
        end if;
      end if;

      if v_error is null and exists (
        select 1 from subscriptions
        where user_email = v_user_email and license_id = v_license.id and fy = v_fy
          and status not in ('declined', 'revoked', 'cancelled')
      ) then
        v_error := 'Already has a subscription for FY' || v_fy;
      end if;

      if v_error is not null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', v_error, 'row', v_row);
        continue;
      end if;

      insert into subscriptions (
        user_email, license_id, suite_key, billing_type, ministry_id, fy, status, activated_at,
        billing_cycle, renewal_month, renewal_reminder, price_at_signup, requested_by
      ) values (
        v_user_email, v_license.id, v_suite_key, v_billing_type, v_ministry_id, v_fy, 'active', v_start_date,
        v_license.billing_cycle, v_license.renewal_month, v_license.renewal_reminder, v_license.price, current_profile_id()
      ) returning id into v_sub_id;

      if v_ministry_id is not null then
        insert into ministry_ids (email, ministry_id) values (v_user_email, v_ministry_id)
          on conflict (email) do update set ministry_id = excluded.ministry_id;
      end if;

      insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
      values (
        'imported', v_sub_id, v_license.name, v_user_email,
        case when v_billing_type = 'gtis' then 'GTIS' when v_billing_type = 'ministry' then 'MIN:' || v_ministry_id else v_suite_key end,
        v_admin, 'imported from legacy system', current_client_ip()
      );

      v_results := v_results || jsonb_build_object('ok', true, 'id', v_sub_id, 'row', v_row);
    exception when others then
      v_results := v_results || jsonb_build_object('ok', false, 'error', sqlerrm, 'row', v_row);
    end;
  end loop;

  return v_results;
end;
$$;

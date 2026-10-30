-- Run this in the Supabase SQL Editor.
--
-- Department approval isn't a way of paying. 40_department_gated_licenses.sql
-- added billing_type 'department' because billing_type is NOT NULL and a
-- department-gated license (Gemini: $0) has no SuiteKey or Ministry ID to
-- bill — conflating "who pays" with "who approves". The approval gate already
-- lives on licenses.department_gated + department_approvals and is decided in
-- request_subscription(); billing_type only needs to say nobody pays.
--
-- Renames the enum value 'department' -> 'free' in place, so every existing
-- row converts with no data migration. plpgsql bodies are plain text, so the
-- functions that wrote or labelled the old literal are redefined below in the
-- same run — request_subscription() would otherwise fail for every
-- department-gated request with "invalid input value for enum".
--
-- Safe to re-run.

do $$
begin
  if exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'subscription_billing_type' and e.enumlabel = 'department'
  ) then
    alter type subscription_billing_type rename value 'department' to 'free';
  end if;
end $$;

-- ─── request_subscription ───────────────────────────────────────────────────
-- Latest body from 73_area_pricing.sql; only change is 'department' -> 'free'.

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

  if not v_license.allow_multiple_per_person and exists (
    select 1 from subscriptions
    where user_email = v_recipient_email and license_id = p_license_id and fy = p_fy
      and status not in ('declined', 'revoked', 'cancelled')
  ) then
    raise exception 'a subscription for this license already exists for this fiscal year';
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

-- ─── start_renewal_period ───────────────────────────────────────────────────
-- Latest body from 73_area_pricing.sql; only change is the 'free' label (was
-- falling through to the null suite_key).

create or replace function start_renewal_period(p_license_id uuid, p_fiscal_year int)
returns table(
  subscription_id uuid, user_email text, license_name text, billing_label text,
  renewal_price numeric, renewal_month int, reminder_message text
) language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;

  return query
  with opened as (
    update subscriptions s set open_renewal_fy = p_fiscal_year
    where s.license_id = p_license_id
      and s.status = 'active'
      and s.billing_cycle = 'annual'
      and s.renewal_reminder = true
      and s.billing_type != 'gtis'
      and s.open_renewal_fy is null
      and s.fy < p_fiscal_year
      and not exists (
        select 1 from renewals r where r.subscription_id = s.id and r.fiscal_year = p_fiscal_year
      )
    returning s.id, s.user_email, s.suite_key, s.ministry_id, s.billing_type,
      s.renewal_month, s.license_id
  ), logged as (
    insert into renewals (subscription_id, fiscal_year, reminder_sent_at, decision)
    select o.id, p_fiscal_year, now(), 'none' from opened o
    returning renewals.subscription_id
  )
  select
    o.id, o.user_email, l.name,
    case
      when o.billing_type = 'gtis' then 'GTIS'
      when o.billing_type = 'ministry' then 'Ministry ID ' || o.ministry_id
      when o.billing_type = 'free' then 'Free'
      else o.suite_key
    end,
    get_area_discounted_price(l.id, o.suite_key), o.renewal_month, l.reminder_message
  from opened o
  join licenses l on l.id = o.license_id;
end;
$$;

-- ─── get_finance_export ─────────────────────────────────────────────────────
-- Latest body from 58_finance_export_extra_field.sql; only change is the
-- 'free' label (department-gated rows used to export a blank billing label).
-- Also carries receiving_suite_key (79_finance_export_receiving_suite_key.sql):
-- that column changes the return type, so the function is dropped first.

drop function if exists get_finance_export(date, date);
create function get_finance_export(p_start_date date, p_end_date date)
returns table(
  user_email text, license_name text, billing_label text, receiving_suite_key text, cost numeric, price_paid numeric,
  product_key text, invoice_number text, start_date date, renewed_date date, status text, notes text
) language sql stable as $$
  select
    s.user_email,
    l.name,
    case
      when s.billing_type = 'gtis' then 'GTIS'
      when s.billing_type = 'ministry' then 'Ministry ID ' || s.ministry_id
      when s.billing_type = 'free' then 'Free'
      else s.suite_key
    end,
    l.receiving_suite_key,
    calc_prorated_cost(l.price, l.billing_cycle, l.renewal_month, l.pro_rated, s.start_date),
    s.price_at_signup,
    s.product_key,
    s.invoice_number,
    s.start_date,
    (select max(r.opt_in_date) from renewals r where r.subscription_id = s.id),
    s.status::text,
    concat_ws(
      '; ',
      s.notes,
      case when s.extra_field_value is not null
        then coalesce(l.extra_field_label, 'Extra field') || ': ' || s.extra_field_value
      end
    )
  from subscriptions s
  join licenses l on l.id = s.license_id
  where s.status = 'active'
     or (s.status = 'approved' and s.start_date >= p_start_date and s.start_date <= p_end_date)
  order by s.start_date;
$$;

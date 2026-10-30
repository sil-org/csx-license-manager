-- Run this in the Supabase SQL Editor.
--
-- Upgrades/downgrades between tiers of the same product (e.g. Claude Standard
-- -> Claude Premium): people were ending up with both seats because they
-- requested the new tier and never cancelled the old one.
--
-- Admin -> Catalog's "More settings" gets an "Exclusive group" text field.
-- Licenses that share the same group name (e.g. "claude") are tiers of one
-- thing, so a person should only hold one of them. When an admin/service
-- manager ACTIVATES a subscription in a group, any other approved/active
-- subscription the same person has in that group is cancelled automatically,
-- with the reason "Upgraded to X" / "Downgraded to X" (decided by comparing
-- the licenses' catalog prices; "Replaced by X" if either has none or they
-- are equal), and an audit_log row for each.
--
-- Deliberately tied to activation, not to the request: activate_subscription()
-- is only ever called by a human (admin / service manager) clicking Activate,
-- so imports and automated syncs never swap anything, and the old seat stays
-- until the new one is actually live (a declined or abandoned upgrade request
-- doesn't cost anyone their existing seat).

alter table licenses add column if not exists exclusive_group text;

-- activate_subscription: latest body from supabase/pending/78_critical_auth_hardening.sql
-- (require_profile_email() + coalesce'd guard); only change is the tier-swap block.
create or replace function activate_subscription(p_subscription_id uuid, p_price numeric default null)
returns void language plpgsql security definer as $$
declare
  v_email text := require_profile_email();
  v_sub subscriptions%rowtype;
  v_license licenses%rowtype;
  v_old record;
  v_verb text;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status != 'approved' then raise exception 'subscription is not approved'; end if;

  select * into v_license from licenses where id = v_sub.license_id;
  if not coalesce((is_admin() or v_email = any(v_license.service_manager_emails)), false) then
    raise exception 'not authorized to activate this subscription';
  end if;

  update subscriptions
  set status = 'active', activated_at = current_date, price_at_signup = coalesce(p_price, price_at_signup)
  where id = p_subscription_id;

  -- Google Group membership (when licenses.google_group_email is set) is
  -- handled asynchronously by sync-provisioning's google_group pass, kicked
  -- from the same UI action that calls this RPC — see
  -- supabase/functions/sync-provisioning/adapters/google-group.ts.
  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, ip_address)
  values ('activated', p_subscription_id, v_license.name, v_sub.user_email, v_sub.suite_key, v_email, current_client_ip());

  -- Tier swap: cancel this person's other seats in the same exclusive group.
  if v_license.exclusive_group is not null then
    for v_old in
      select s.id, s.suite_key, l.name as license_name, l.price as license_price
      from subscriptions s
      join licenses l on l.id = s.license_id
      where lower(s.user_email) = lower(v_sub.user_email)
        and s.id <> v_sub.id
        and s.license_id <> v_sub.license_id
        and s.status in ('approved', 'active')
        and l.exclusive_group = v_license.exclusive_group
    loop
      v_verb := case
        when v_old.license_price is null or v_license.price is null or v_old.license_price = v_license.price then 'Replaced by'
        when v_license.price > v_old.license_price then 'Upgraded to'
        else 'Downgraded to'
      end;

      update subscriptions set status = 'cancelled' where id = v_old.id;

      insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
      values ('cancelled', v_old.id, v_old.license_name, v_sub.user_email, v_old.suite_key, v_email,
              v_verb || ' ' || v_license.name, current_client_ip());
    end loop;
  end if;
end;
$$;

-- ─── RPC: save_license (adds exclusive_group) ────────────────────────────
-- Latest body from supabase/pending/78_license_receiving_suite_key.sql.

create or replace function save_license(p_license jsonb)
returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
  v_service_manager_emails text[];
begin
  if not is_admin() then raise exception 'admin only'; end if;

  select coalesce(array_agg(trim(e)), '{}'::text[]) into v_service_manager_emails
  from jsonb_array_elements_text(coalesce(p_license->'service_manager_emails', '[]'::jsonb)) e
  where trim(e) <> '';

  v_id := (p_license->>'id')::uuid;
  if v_id is null then
    insert into licenses (
      name, vendor, category, price, price_unit, notes, gtis_sponsored,
      billing_cycle, renewal_month, renewal_reminder, logo_url, activation_url,
      more_info_url, google_group_email, pro_rated, service_manager_emails,
      onboarding_message, reminder_message, provisioning_adapter, provisioning_config,
      provisioning_email_show_name, provisioning_email_show_job_title, provisioning_email_show_department,
      department_gated, requires_acknowledgement, acknowledgement_text,
      extra_field_label, extra_field_required, allow_multiple_per_person, receiving_suite_key, exclusive_group, created_by
    ) values (
      p_license->>'name', p_license->>'vendor', p_license->>'category',
      (p_license->>'price')::numeric, p_license->>'price_unit', p_license->>'notes',
      coalesce((p_license->>'gtis_sponsored')::boolean, false),
      coalesce((p_license->>'billing_cycle')::billing_cycle, 'annual'),
      (p_license->>'renewal_month')::int,
      coalesce((p_license->>'renewal_reminder')::boolean, true),
      p_license->>'logo_url', p_license->>'activation_url', p_license->>'more_info_url',
      p_license->>'google_group_email', coalesce((p_license->>'pro_rated')::boolean, false),
      v_service_manager_emails,
      nullif(p_license->>'onboarding_message', ''), nullif(p_license->>'reminder_message', ''),
      nullif(p_license->>'provisioning_adapter', ''), nullif(p_license->>'provisioning_config', '')::jsonb,
      coalesce((p_license->>'provisioning_email_show_name')::boolean, false),
      coalesce((p_license->>'provisioning_email_show_job_title')::boolean, false),
      coalesce((p_license->>'provisioning_email_show_department')::boolean, false),
      coalesce((p_license->>'department_gated')::boolean, false),
      coalesce((p_license->>'requires_acknowledgement')::boolean, false),
      nullif(p_license->>'acknowledgement_text', ''),
      nullif(p_license->>'extra_field_label', ''),
      coalesce((p_license->>'extra_field_required')::boolean, false),
      coalesce((p_license->>'allow_multiple_per_person')::boolean, false),
      coalesce(nullif(trim(p_license->>'receiving_suite_key'), ''), 'WaxhawIT-U_SIL'),
      nullif(trim(p_license->>'exclusive_group'), ''),
      current_profile_id()
    ) returning id into v_id;
  else
    update licenses set
      name = p_license->>'name', vendor = p_license->>'vendor', category = p_license->>'category',
      price = (p_license->>'price')::numeric, price_unit = p_license->>'price_unit', notes = p_license->>'notes',
      gtis_sponsored = coalesce((p_license->>'gtis_sponsored')::boolean, false),
      billing_cycle = coalesce((p_license->>'billing_cycle')::billing_cycle, 'annual'),
      renewal_month = (p_license->>'renewal_month')::int,
      renewal_reminder = coalesce((p_license->>'renewal_reminder')::boolean, true),
      logo_url = p_license->>'logo_url', activation_url = p_license->>'activation_url',
      more_info_url = p_license->>'more_info_url', google_group_email = p_license->>'google_group_email',
      pro_rated = coalesce((p_license->>'pro_rated')::boolean, false),
      service_manager_emails = v_service_manager_emails,
      onboarding_message = nullif(p_license->>'onboarding_message', ''),
      reminder_message = nullif(p_license->>'reminder_message', ''),
      provisioning_adapter = nullif(p_license->>'provisioning_adapter', ''),
      provisioning_config = nullif(p_license->>'provisioning_config', '')::jsonb,
      provisioning_email_show_name = coalesce((p_license->>'provisioning_email_show_name')::boolean, false),
      provisioning_email_show_job_title = coalesce((p_license->>'provisioning_email_show_job_title')::boolean, false),
      provisioning_email_show_department = coalesce((p_license->>'provisioning_email_show_department')::boolean, false),
      department_gated = coalesce((p_license->>'department_gated')::boolean, false),
      requires_acknowledgement = coalesce((p_license->>'requires_acknowledgement')::boolean, false),
      acknowledgement_text = nullif(p_license->>'acknowledgement_text', ''),
      extra_field_label = nullif(p_license->>'extra_field_label', ''),
      extra_field_required = coalesce((p_license->>'extra_field_required')::boolean, false),
      allow_multiple_per_person = coalesce((p_license->>'allow_multiple_per_person')::boolean, false),
      receiving_suite_key = coalesce(nullif(trim(p_license->>'receiving_suite_key'), ''), 'WaxhawIT-U_SIL'),
      exclusive_group = nullif(trim(p_license->>'exclusive_group'), '')
    where id = v_id;
  end if;

  return v_id;
end;
$$;

-- ─── Setup + cleanup of existing duplicates ───────────────────────────────
-- 1. In Admin -> Catalog, give Claude Standard and Claude Premium the same
--    Exclusive group (e.g. "claude").
-- 2. This lists anyone who currently holds more than one seat in the same
--    group, so the leftover lower tier can be cancelled by hand (nothing is
--    changed automatically for existing rows — the swap only fires on the
--    next activation).

select s.user_email, l.exclusive_group, l.name, l.price, s.status, s.activated_at, s.id
from subscriptions s
join licenses l on l.id = s.license_id
where l.exclusive_group is not null
  and s.status in ('approved', 'active')
  and exists (
    select 1 from subscriptions s2
    join licenses l2 on l2.id = s2.license_id
    where lower(s2.user_email) = lower(s.user_email)
      and s2.id <> s.id
      and s2.license_id <> s.license_id
      and s2.status in ('approved', 'active')
      and l2.exclusive_group = l.exclusive_group
  )
order by s.user_email, l.price;

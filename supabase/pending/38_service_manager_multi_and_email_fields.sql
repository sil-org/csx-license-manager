-- Run this in the Supabase SQL Editor. Adds real multi-recipient support for
-- service managers (a license could only ever have one before, or a Google
-- Group address as a workaround) and three admin-controlled flags for which
-- extra fields show up in the provisioning-required email (name/job title/
-- department) alongside the seat user's email, which is always shown.
-- Default all three to false — most service managers only want the plain
-- email address; see provisioningRequiredEmailHtml() in src/lib/email.js.
--
-- Also fully reconciles save_license(): pending/13_provisioning_adapters.sql
-- added provisioning_adapter/provisioning_config, but
-- pending/20_reminder_message_override.sql (written after 13, from a stale
-- copy that predated 13's change) redefined save_license() without them —
-- a real regression if the pending queue was ever run straight through in
-- file order. This rewrite is the full reconciled param list; treat it as
-- the new source of truth, not a diff against 20.

alter table licenses add column if not exists service_manager_emails text[] not null default '{}';
update licenses set service_manager_emails = array[service_manager_email]
  where service_manager_email is not null and service_manager_email <> '';

alter table licenses add column if not exists provisioning_email_show_name boolean not null default false;
alter table licenses add column if not exists provisioning_email_show_job_title boolean not null default false;
alter table licenses add column if not exists provisioning_email_show_department boolean not null default false;

create or replace function is_service_manager_for(p_license_id uuid)
returns boolean language sql stable security definer as $$
  select exists(
    select 1 from licenses
    where id = p_license_id and current_profile_email() = any(service_manager_emails)
  )
$$;

create or replace function is_service_manager_any()
returns boolean language sql stable security definer as $$
  select exists(select 1 from licenses where current_profile_email() = any(service_manager_emails))
$$;

drop policy if exists "licenses: read active, or own scope" on licenses;
create policy "licenses: read active, or own scope" on licenses for select
  using (active or is_admin() or current_profile_email() = any(service_manager_emails));

-- Only safe to drop now that the policy above no longer references it —
-- Postgres tracks a policy's USING clause as a real dependency on the
-- column, unlike a plain function body, which is why this has to come after
-- the policy rewrite instead of right after the new column's backfill.
alter table licenses drop column if exists service_manager_email;

create or replace function activate_subscription(p_subscription_id uuid, p_price numeric default null)
returns void language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_sub subscriptions%rowtype;
  v_license licenses%rowtype;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status != 'approved' then raise exception 'subscription is not approved'; end if;

  select * into v_license from licenses where id = v_sub.license_id;
  if not (is_admin() or v_email = any(v_license.service_manager_emails)) then
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
end;
$$;

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
      created_by
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
      provisioning_email_show_department = coalesce((p_license->>'provisioning_email_show_department')::boolean, false)
    where id = v_id;
  end if;

  return v_id;
end;
$$;

-- admin_import_licenses() (supabase/pending/17_gas_historical_import.sql) —
-- GAS's Licenses sheet only ever had one service-manager address, so a
-- single-element array (or empty) is the correct mapping; no delimiter
-- splitting needed here, unlike a hypothetical multi-value CSV source.
create or replace function admin_import_licenses(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_legacy_id text;
  v_name text;
  v_billing_cycle billing_cycle;
  v_created_by uuid;
  v_id uuid;
  v_error text;
  v_service_manager_email text;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_error := null;
      v_legacy_id := nullif(trim(v_row->>'legacy_id'), '');
      v_name := trim(v_row->>'name');

      if v_name = '' or v_name is null then
        v_error := 'Missing name';
      elsif exists (
        select 1 from licenses
        where (v_legacy_id is not null and legacy_id = v_legacy_id) or lower(name) = lower(v_name)
      ) then
        v_error := 'Already exists: ' || v_name;
      end if;

      if v_error is not null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', v_error, 'row', v_row);
        continue;
      end if;

      v_billing_cycle := coalesce(nullif(v_row->>'billing_cycle', ''), 'annual')::billing_cycle;

      v_created_by := null;
      if nullif(trim(v_row->>'created_by_email'), '') is not null then
        select id into v_created_by from profiles where lower(primary_email) = lower(trim(v_row->>'created_by_email'));
      end if;

      v_service_manager_email := nullif(trim(lower(v_row->>'service_manager_email')), '');

      insert into licenses (
        legacy_id, name, vendor, category, price, price_unit, notes, active, gtis_sponsored,
        billing_cycle, renewal_month, renewal_reminder, created_by, logo_url, activation_url,
        more_info_url, google_group_email, pro_rated, service_manager_emails
      ) values (
        v_legacy_id, v_name, nullif(trim(v_row->>'vendor'), ''), nullif(trim(v_row->>'category'), ''),
        nullif(v_row->>'price', '')::numeric,
        case v_billing_cycle when 'annual' then 'per seat/year' when 'monthly' then 'per seat/month' else 'one-time' end,
        nullif(v_row->>'notes', ''),
        coalesce((v_row->>'active')::boolean, true),
        coalesce((v_row->>'gtis_sponsored')::boolean, false),
        v_billing_cycle,
        nullif(v_row->>'renewal_month', '')::int,
        coalesce((v_row->>'renewal_reminder')::boolean, true),
        v_created_by,
        nullif(trim(v_row->>'logo_url'), ''), nullif(trim(v_row->>'activation_url'), ''),
        nullif(trim(v_row->>'more_info_url'), ''), nullif(trim(lower(v_row->>'google_group_email')), ''),
        coalesce((v_row->>'pro_rated')::boolean, false),
        case when v_service_manager_email is null then '{}'::text[] else array[v_service_manager_email] end
      ) returning id into v_id;

      v_results := v_results || jsonb_build_object('ok', true, 'id', v_id, 'row', v_row);
    exception when others then
      v_results := v_results || jsonb_build_object('ok', false, 'error', sqlerrm, 'row', v_row);
    end;
  end loop;

  return v_results;
end;
$$;

-- Run this in the Supabase SQL Editor. Generalizes "keep an external vendor's
-- roster in sync with active subscriptions" into a reusable adapter framework
-- (first consumer: CubeBackup, for the "Google Backup" license) instead of
-- one-off code per license. Mirrors sync-group-memberships' reconciliation
-- model and email_log's logging shape — see supabase/functions/sync-provisioning/.

alter table licenses add column if not exists provisioning_adapter text; -- null = manual (today's behavior); e.g. 'cubebackup'
alter table licenses add column if not exists provisioning_config jsonb; -- adapter-specific settings, e.g. {"domain": "sil.org"}
alter table licenses add column if not exists provisioning_lock_until timestamptz; -- concurrency guard: sync-provisioning claims a license before processing it, so an overlapping run (e.g. a fire-and-forget kick landing mid-scheduled-run) skips rather than double-calling the vendor's API

-- Delivery log for the sync-provisioning Edge Function — one row per
-- enable/disable/error outcome. Mirrors email_log's shape/RLS style: text
-- status/action columns rather than enums, since dispatch logic lives in the
-- Edge Function's adapter modules, not in Postgres.
create table if not exists provisioning_log (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  license_id     uuid references licenses(id),
  adapter        text not null,
  email          text not null,
  action         text not null, -- 'enabled' | 'disabled'
  external_id    text,
  status         text not null, -- 'ok' | 'failed'
  error          text
);

create index if not exists provisioning_log_license_id_idx on provisioning_log (license_id);

alter table provisioning_log enable row level security;
create policy "provisioning_log: admin read" on provisioning_log for select using (is_admin());

-- save_license() gains the two admin-editable columns above. Full
-- create-or-replace since jsonb function bodies can't be altered in place.
create or replace function save_license(p_license jsonb)
returns uuid language plpgsql security definer as $$
declare v_id uuid;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  v_id := (p_license->>'id')::uuid;
  if v_id is null then
    insert into licenses (
      name, vendor, category, price, price_unit, notes, gtis_sponsored,
      billing_cycle, renewal_month, renewal_reminder, logo_url, activation_url,
      more_info_url, google_group_email, pro_rated, service_manager_email,
      onboarding_message, provisioning_adapter, provisioning_config, created_by
    ) values (
      p_license->>'name', p_license->>'vendor', p_license->>'category',
      (p_license->>'price')::numeric, p_license->>'price_unit', p_license->>'notes',
      coalesce((p_license->>'gtis_sponsored')::boolean, false),
      coalesce((p_license->>'billing_cycle')::billing_cycle, 'annual'),
      (p_license->>'renewal_month')::int,
      coalesce((p_license->>'renewal_reminder')::boolean, true),
      p_license->>'logo_url', p_license->>'activation_url', p_license->>'more_info_url',
      p_license->>'google_group_email', coalesce((p_license->>'pro_rated')::boolean, false),
      p_license->>'service_manager_email', nullif(p_license->>'onboarding_message', ''),
      nullif(p_license->>'provisioning_adapter', ''), nullif(p_license->>'provisioning_config', '')::jsonb,
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
      service_manager_email = p_license->>'service_manager_email',
      onboarding_message = nullif(p_license->>'onboarding_message', ''),
      provisioning_adapter = nullif(p_license->>'provisioning_adapter', ''),
      provisioning_config = nullif(p_license->>'provisioning_config', '')::jsonb
    where id = v_id;
  end if;

  return v_id;
end;
$$;

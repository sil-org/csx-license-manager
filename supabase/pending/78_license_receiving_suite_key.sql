-- Run this in the Supabase SQL Editor.
--
-- Adds licenses.receiving_suite_key: the suite key that receives each catalog
-- license's charges. Every license gets the same default ('WaxhawIT-U_SIL'),
-- backfilled onto existing rows by the column default itself, and it's
-- editable per license in Admin -> Catalog's collapsed "More settings".
-- Saving it blank resets it to the default. Plain text rather than an FK to
-- suite_keys: it's a destination, not a billed-to key with an owner.

alter table licenses add column if not exists receiving_suite_key text not null default 'WaxhawIT-U_SIL';

-- ─── RPC: save_license (adds receiving_suite_key) ────────────────────────

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
      extra_field_label, extra_field_required, allow_multiple_per_person, receiving_suite_key, created_by
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
      receiving_suite_key = coalesce(nullif(trim(p_license->>'receiving_suite_key'), ''), 'WaxhawIT-U_SIL')
    where id = v_id;
  end if;

  return v_id;
end;
$$;

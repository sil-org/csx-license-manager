-- Run this in the Supabase SQL Editor.
--
-- licenses.receiving_suite_key: the suite key that is credited for a catalog
-- item (Admin -> Catalog's "More settings"). Every license defaults to
-- WaxhawIT-U_SIL; saving the field blank resets it to that default. It is
-- exported as the "Receiving suite key" column of the Finance Export.

alter table licenses add column if not exists receiving_suite_key text not null default 'WaxhawIT-U_SIL';

-- ─── RPC: save_license (adds receiving_suite_key) ───────────────────────────
-- Latest body from 56_allow_multiple_per_person.sql.

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

-- ─── get_finance_export ─────────────────────────────────────────────────────
-- Latest body from 80_free_billing_type.sql; adds receiving_suite_key right
-- after billing_label. The return type changes, so the function is dropped
-- first and its grants (see 78_critical_auth_hardening.sql) re-applied.

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

revoke execute on function get_finance_export(date, date) from public, anon;
grant execute on function get_finance_export(date, date) to authenticated, service_role;

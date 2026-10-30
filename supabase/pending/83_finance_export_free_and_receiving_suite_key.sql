-- Run this in the Supabase SQL Editor.
--
-- Reconciles get_finance_export() after 79_finance_export_receiving_suite_key.sql
-- (which was written before 80_free_billing_type.sql and so lacks its 'Free'
-- billing label): keeps both the 'free' label and receiving_suite_key.
-- Idempotent; safe to run whether or not 80 has been run.

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

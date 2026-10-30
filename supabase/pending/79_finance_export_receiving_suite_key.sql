-- Run this in the Supabase SQL Editor.
--
-- Adds licenses.receiving_suite_key (see 78_license_receiving_suite_key.sql)
-- to get_finance_export() as its own column, right after billing_label, so
-- Admin -> Finance Export's CSV shows which suite key receives each
-- subscription's charges. Adds a new OUT column, so Postgres won't let
-- create-or-replace alter the return type in place — drop it first.

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
    -- Folds in extra_field_value (e.g. a Shared Drive's name) so it isn't
    -- lost from the export when an admin never separately typed it into
    -- notes — extra_field_value is set once at request time and often left
    -- as the only record of it (see licenses.extra_field_label).
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

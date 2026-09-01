-- Run this in the Supabase SQL Editor.
--
-- Bug: get_finance_export()'s Notes column only ever surfaced
-- subscriptions.notes (a manually-typed admin annotation), never
-- subscriptions.extra_field_value (e.g. a Shared Drive's name, captured
-- automatically at request time via licenses.extra_field_label — see
-- 49_license_extra_field_and_price_unit.sql). Any subscription where an
-- admin relied on the extra field alone — the normal path — showed up in
-- the Finance Export with a blank Notes cell even though the value was
-- populated one column over.
--
-- Fix: fold extra_field_value into the exported Notes text, labeled with
-- the license's extra_field_label, alongside any manual notes rather than
-- replacing them. Same signature/return type as before, so no drop needed.

create or replace function get_finance_export(p_start_date date, p_end_date date)
returns table(
  user_email text, license_name text, billing_label text, cost numeric, price_paid numeric,
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

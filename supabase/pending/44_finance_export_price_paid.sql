-- Finance needs the actual price charged, not just the recalculated `cost`.
-- `cost` (calc_prorated_cost) always joins against the license's *current*
-- price, so once a license's price changes, every past export recalculates
-- old subscriptions at the new price instead of what was actually charged.
-- subscriptions.price_at_signup snapshots the license price at request/
-- activation time (see request_subscription()/activate_subscription()) —
-- surface it as price_paid alongside cost so finance can see both.
-- Adds a new OUT column, so Postgres won't let create-or-replace alter the
-- existing return type in place — drop it first.
drop function if exists get_finance_export(date, date);

create function get_finance_export(p_start_date date, p_end_date date)
returns table(
  user_email text, license_name text, billing_label text, cost numeric, price_paid numeric,
  start_date date, renewed_date date, status text
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
    s.start_date,
    (select max(r.opt_in_date) from renewals r where r.subscription_id = s.id),
    s.status::text
  from subscriptions s
  join licenses l on l.id = s.license_id
  where s.status = 'active'
     or (s.status = 'approved' and s.start_date >= p_start_date and s.start_date <= p_end_date)
  order by s.start_date;
$$;

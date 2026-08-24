-- get_finance_export() filtered every status, including 'active', by
-- start_date falling inside the requested range. start_date is set once at
-- signup and never touched again on renewal (opt_in_renewal() only logs to
-- renewals and flips renewal_status — see 23_activated_at.sql's comment on
-- start_date's meaning), so an active subscription only ever appeared in the
-- one export whose range happened to cover its original start_date. Every
-- later fiscal year's export silently dropped it even though it was still
-- active and still billable. 'approved' rows (not yet activated) still need
-- the range filter — otherwise every never-activated approval ever made
-- would show up in every export forever.

-- renewed_date surfaces the most recent fiscal-year renewal opt-in
-- (renewals.opt_in_date) so finance can tell a long-running active
-- subscription apart from one still on its original term — null means it
-- hasn't been through opt_in_renewal() yet.
-- Adds a new OUT column, so Postgres won't let create-or-replace alter the
-- existing return type in place — drop it first.
drop function if exists get_finance_export(date, date);

create function get_finance_export(p_start_date date, p_end_date date)
returns table(
  user_email text, license_name text, billing_label text, cost numeric, start_date date,
  renewed_date date, status text
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
    s.start_date,
    (select max(r.opt_in_date) from renewals r where r.subscription_id = s.id),
    s.status::text
  from subscriptions s
  join licenses l on l.id = s.license_id
  where s.status = 'active'
     or (s.status = 'approved' and s.start_date >= p_start_date and s.start_date <= p_end_date)
  order by s.start_date;
$$;

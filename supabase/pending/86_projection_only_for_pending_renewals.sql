-- "Projected" counted a renewal that can't exist yet.
--
-- get_team_spend() and get_suite_key_spend() estimate every active annual
-- subscription with no opted_in/opted_out renewal row for the requested FY as
-- an undecided renewal (current price + 10%). But renewal rows are only ever
-- opened for subscriptions signed up in an earlier FY (start_renewal_period()
-- requires s.fy < the renewal FY), so a subscription whose own signup term
-- still covers the FY never has one — it was projected as renewing into the
-- very year it was just bought for, on top of its actual signup amount. E.g.
-- two Zoom Pro seats started 2026-10-01/02 (renewal month October) each got
-- $216 actual plus a $237.60 projected FY2027 renewal; their first renewal is
-- Oct 2027, i.e. FY2028.
--
-- Fix: only project when the subscription's signup term has ended by the
-- start of the renewal term for p_fiscal_year — the same term start that
-- subscription_actual_fy_amount() uses for decided renewals:
--   make_date(<renewal_month >= 10 ? FY-1 : FY>, renewal_month, 1)
-- and start_date must be strictly before it. This also covers non-October
-- renewal months (a Nov 2026 signup renewing in Mar 2027 still projects its
-- Mar-Sep FY2027 tail; a Nov 2026 signup with an October renewal month does
-- not).
--
-- Both bodies are copied verbatim from 72 apart from the one added condition
-- in each projected_amounts CTE. Signatures and return types are unchanged,
-- so grants from 78 carry over and there is no overload to drop. "Actual" is
-- untouched.
create or replace function get_team_spend(p_fiscal_year int)
returns table(billing_type text, actual numeric, projected numeric)
language sql stable security definer as $$
  with team as (
    select lower(current_profile_email()) as email
    union
    select get_report_emails()
  ),
  eligible_subs as (
    select s.*, l.price as license_price, s.billing_type::text as billing_type_text
    from subscriptions s
    join licenses l on l.id = s.license_id
    where lower(s.user_email) in (select email from team)
      and s.billing_type in ('suite_key', 'ministry', 'gtis')
  ),
  actual_totals as (
    select billing_type_text, sum(subscription_actual_fy_amount(id, p_fiscal_year)) as amount
    from eligible_subs
    group by billing_type_text
  ),
  projected_amounts as (
    select billing_type_text,
      sum(license_price * 1.10 * fy_boundary_months(coalesce(nullif(renewal_month, 0), 10)) / 12.0) as amount
    from eligible_subs es
    where es.status = 'active'
      and es.billing_cycle = 'annual'
      and es.renewal_reminder = true
      and es.billing_type_text != 'gtis'
      -- Only a subscription whose signup term has ended by the start of the
      -- renewal term for p_fiscal_year can have a renewal decision pending.
      and es.start_date < make_date(
            case when coalesce(nullif(es.renewal_month, 0), 10) >= 10
                 then p_fiscal_year - 1 else p_fiscal_year end,
            coalesce(nullif(es.renewal_month, 0), 10), 1)
      and not exists (
        select 1 from renewals r
        where r.subscription_id = es.id
          and r.fiscal_year = p_fiscal_year
          and r.decision in ('opted_in', 'opted_out')
      )
    group by billing_type_text
  ),
  categories as (
    select unnest(array['suite_key', 'ministry', 'gtis']) as billing_type_text
  )
  select
    c.billing_type_text,
    coalesce((select amount from actual_totals att where att.billing_type_text = c.billing_type_text), 0) as actual,
    coalesce((select amount from projected_amounts pa where pa.billing_type_text = c.billing_type_text), 0) as projected
  from categories c;
$$;

create or replace function get_suite_key_spend(p_fiscal_year int)
returns table(suite_key text, actual numeric, projected numeric)
language sql stable security definer as $$
  with eligible_subs as (
    select s.*, l.price as license_price
    from subscriptions s
    join licenses l on l.id = s.license_id
    where s.billing_type = 'suite_key' and is_suite_key_owner(s.suite_key)
  ),
  actual_totals as (
    select suite_key, sum(subscription_actual_fy_amount(id, p_fiscal_year)) as amount
    from eligible_subs
    group by suite_key
  ),
  projected_amounts as (
    select suite_key,
      sum(license_price * 1.10 * fy_boundary_months(coalesce(nullif(renewal_month, 0), 10)) / 12.0) as amount
    from eligible_subs es
    where es.status = 'active'
      and es.billing_cycle = 'annual'
      and es.renewal_reminder = true
      -- Only a subscription whose signup term has ended by the start of the
      -- renewal term for p_fiscal_year can have a renewal decision pending.
      and es.start_date < make_date(
            case when coalesce(nullif(es.renewal_month, 0), 10) >= 10
                 then p_fiscal_year - 1 else p_fiscal_year end,
            coalesce(nullif(es.renewal_month, 0), 10), 1)
      and not exists (
        select 1 from renewals r
        where r.subscription_id = es.id
          and r.fiscal_year = p_fiscal_year
          and r.decision in ('opted_in', 'opted_out')
      )
    group by suite_key
  ),
  keys as (
    select suite_key from suite_keys where is_suite_key_owner(suite_key)
  )
  select
    k.suite_key,
    coalesce((select amount from actual_totals att where att.suite_key = k.suite_key), 0) as actual,
    coalesce((select amount from projected_amounts pa where pa.suite_key = k.suite_key), 0) as projected
  from keys k
  order by k.suite_key;
$$;

-- Sanity check after applying (read-only): the two Zoom seats started
-- 2026-10-01/02 should no longer be projected for FY2027.
--   select suite_key, actual, projected from get_suite_key_spend(2027);

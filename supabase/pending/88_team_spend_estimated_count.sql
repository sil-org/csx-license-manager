-- Same "Est." signal as 87, for the My Team spend card.
--
-- get_team_spend() now also returns estimated_count per billing type: how many
-- subscriptions behind that total for the FY rest on a fallback price (null
-- price_at_signup estimated at the license's current price, see 84/85/87).
-- TeamSpendCard.jsx shows an "Est." chip on the SuiteKey / Ministry tiles and a
-- footnote when it is > 0. GTIS is never flagged — it is priced from the
-- license by design. The count is approximate: it flags a tile, it is not a
-- ledger.
--
-- Adding an OUT column changes the return type, so the old function is dropped
-- (no stale overload — see issue #23) and the grants from 78 are re-applied.
-- The frontend tolerates the column being absent, so deploy order doesn't
-- matter. Body is 86's, plus the estimated CTE and column.
drop function if exists get_team_spend(int);

create or replace function get_team_spend(p_fiscal_year int)
returns table(billing_type text, actual numeric, projected numeric, estimated_count int)
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
  -- Subscriptions whose amount for this FY leans on a price nobody recorded:
  -- price_at_signup is null (legacy GAS import, see 77) and the signup /
  -- monthly amount falls back to the license's current price (84/85).
  -- Annual: only when the signup term lands in (or spills into) the FY —
  -- later FYs are carried by decided renewals, which have real prices.
  -- 'gtis' always uses the license price by design, so it isn't flagged.
  estimated as (
    select es.billing_type_text, count(*)::int as n
    from eligible_subs es
    where es.price_at_signup is null
      and es.status <> 'declined'
      and es.billing_type_text <> 'gtis'
      and (
        es.billing_cycle = 'monthly'
        or (es.billing_cycle = 'annual' and (
              case when extract(month from es.start_date) >= 10
                   then extract(year from es.start_date)::int + 1
                   else extract(year from es.start_date)::int end
            ) in (p_fiscal_year, p_fiscal_year - 1))
      )
      and subscription_actual_fy_amount(es.id, p_fiscal_year) > 0
    group by es.billing_type_text
  ),
  categories as (
    select unnest(array['suite_key', 'ministry', 'gtis']) as billing_type_text
  )
  select
    c.billing_type_text,
    coalesce((select amount from actual_totals att where att.billing_type_text = c.billing_type_text), 0) as actual,
    coalesce((select amount from projected_amounts pa where pa.billing_type_text = c.billing_type_text), 0) as projected,
    coalesce((select n from estimated e where e.billing_type_text = c.billing_type_text), 0) as estimated_count
  from categories c;
$$;

revoke execute on function get_team_spend(int) from public, anon;
grant execute on function get_team_spend(int) to authenticated, service_role;

-- Sanity check after applying, as a signed-in manager (impersonation or the app):
--   select * from get_team_spend(2027);   -- estimated_count present; gtis = 0

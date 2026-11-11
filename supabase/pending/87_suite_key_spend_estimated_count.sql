-- Tell the SuiteKey Charges tiles which totals are estimates.
--
-- 84/85 let amounts fall back to the license's current price when a
-- subscription's price_at_signup was never recorded (~1,500 legacy rows), and
-- the page showed those as ordinary figures. get_suite_key_spend() now also
-- returns estimated_count: how many subscriptions behind each key's total for
-- the FY rest on such a fallback price. SuiteKeySpendCard.jsx shows an "Est."
-- chip on the tile (and a footnote) when it is > 0. The count is approximate
-- by design — it flags a tile, it is not a ledger.
--
-- Adding an OUT column changes the return type, which create-or-replace can't
-- do, so the old function is dropped (no stale overload — see issue #23) and
-- the grants 78 applied are re-applied: execute revoked from public/anon,
-- granted to authenticated/service_role. The frontend tolerates the column
-- being absent, so deploy order doesn't matter. get_team_spend() is unchanged.
drop function if exists get_suite_key_spend(int);

create or replace function get_suite_key_spend(p_fiscal_year int)
returns table(suite_key text, actual numeric, projected numeric, estimated_count int)
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
  -- Subscriptions whose amount for this FY leans on a price nobody recorded:
  -- price_at_signup is null (legacy GAS import, see 77) and the signup /
  -- monthly amount falls back to the license's current price (84/85).
  -- Annual: only when the signup term lands in (or spills into) the FY —
  -- later FYs are carried by decided renewals, which have real prices.
  -- 'gtis' always uses the license price by design, so it isn't flagged.
  estimated as (
    select es.suite_key, count(*)::int as n
    from eligible_subs es
    where es.price_at_signup is null
      and es.status <> 'declined'
      and es.billing_type <> 'gtis'
      and (
        es.billing_cycle = 'monthly'
        or (es.billing_cycle = 'annual' and (
              case when extract(month from es.start_date) >= 10
                   then extract(year from es.start_date)::int + 1
                   else extract(year from es.start_date)::int end
            ) in (p_fiscal_year, p_fiscal_year - 1))
      )
      and subscription_actual_fy_amount(es.id, p_fiscal_year) > 0
    group by es.suite_key
  ),
  keys as (
    select suite_key from suite_keys where is_suite_key_owner(suite_key)
  )
  select
    k.suite_key,
    coalesce((select amount from actual_totals att where att.suite_key = k.suite_key), 0) as actual,
    coalesce((select amount from projected_amounts pa where pa.suite_key = k.suite_key), 0) as projected,
    coalesce((select n from estimated e where e.suite_key = k.suite_key), 0) as estimated_count
  from keys k
  order by k.suite_key;
$$;

revoke execute on function get_suite_key_spend(int) from public, anon;
grant execute on function get_suite_key_spend(int) to authenticated, service_role;

-- Sanity check after applying: AIM-U_SIL (no null prices) should show 0;
-- an owner with legacy null-price rows should show a count > 0. In the app,
-- or by impersonating an owner as in the earlier checks:
--   select * from get_suite_key_spend(2027);

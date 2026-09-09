-- Two things: (1) a status-aware fix to get_team_spend()'s "actual" figure —
-- it didn't look at subscription status at all, so a declined subscription
-- (never actually charged) counted its price_at_signup anyway, and a
-- cancelled/revoked one counted its full signup fragment/renewal term even
-- though it stopped accruing cost the day it was cut off. (2) the same
-- "actual" math, reused for a new get_suite_key_spend(), grouped by
-- suite_key instead of billing_type, for the SuiteKey Charges page.
--
-- Both share one per-subscription ledger function rather than duplicating
-- this logic twice — subscription_actual_fy_ledger() below is the single
-- source of truth for "how much of this one subscription's cost actually
-- lands in each fiscal year." Rules:
--   - declined: $0 everywhere, it was never charged.
--   - cancelled/revoked: cost stops accruing at the date audit_log records
--     that action. A term (the signup fragment, or a decided renewal) that
--     was still running when that happened is pro-rated down to however
--     many whole months of it had actually elapsed — not the full term.
--   - anything else (pending/approved/active): the full term counts, same
--     as before.
-- "Projected" (not-yet-decided renewals, estimated at current price + 10%)
-- is unaffected by any of this — it already only ever looks at status =
-- 'active' subscriptions, so it stays as its own per-caller query rather
-- than folding into the shared ledger.

-- Months between two calendar months (1-12), wrapping forward — e.g. May
-- (5) to June (6) is 1, May to May is 12. fy_boundary_months() is the same
-- pattern specialized to a target of October; this is the general form,
-- needed for a subscription's own start-month-to-renewal-month span.
create or replace function calendar_month_span(p_from_month int, p_to_month int)
returns int language sql immutable as $$
  select case when p_to_month - p_from_month <= 0 then p_to_month - p_from_month + 12 else p_to_month - p_from_month end
$$;

-- Whole months elapsed between two actual dates — used to find how much of
-- a term ran before a cancellation/revocation cutoff. Same "whole months
-- only" granularity calc_prorated_cost() already uses elsewhere (day-of-
-- month within a term is never part of this app's proration math).
create or replace function calendar_month_span_exact(p_from date, p_to date)
returns numeric language sql immutable as $$
  select extract(year from age(p_to, p_from)) * 12 + extract(month from age(p_to, p_from))
$$;

-- One subscription's contribution to every fiscal year it has ever touched
-- — the signup fragment, split at the Oct 1 boundary the same way as
-- fy_boundary_months(), plus the same split for each decided (opted_in)
-- renewal. Monthly/one-time subscriptions are skipped entirely: FY isn't a
-- meaningful concept for them (see shouldShowFY() in subscriptionDisplay.js
-- — same rule, applied here for the same reason).
create or replace function subscription_actual_fy_ledger(p_subscription_id uuid)
returns table(fiscal_year int, amount numeric)
language plpgsql stable as $$
declare
  s subscriptions%rowtype;
  v_cutoff date;
  v_renewal_month int;
  v_signup_months int;
  v_signup_fy int;
  v_head_months int;
  v_effective_months numeric;
  r record;
  v_term_start date;
  v_term_head_months int;
  v_term_effective_months numeric;
begin
  select * into s from subscriptions where id = p_subscription_id;
  if s.id is null or s.billing_cycle is distinct from 'annual' or s.status = 'declined' then
    return;
  end if;

  if s.status in ('cancelled', 'revoked') then
    select max(a.created_at)::date into v_cutoff
    from audit_log a
    where a.subscription_id = s.id and a.action::text = s.status::text;
  end if;

  v_renewal_month := coalesce(nullif(s.renewal_month, 0), 10);

  -- Signup fragment.
  v_signup_months := calendar_month_span(extract(month from s.start_date)::int, v_renewal_month);
  v_signup_fy := case when extract(month from s.start_date) >= 10
    then extract(year from s.start_date)::int + 1
    else extract(year from s.start_date)::int end;
  v_head_months := fy_boundary_months(extract(month from s.start_date)::int);
  v_effective_months := case when v_cutoff is null then v_signup_months::numeric
    else least(v_signup_months::numeric, greatest(0, calendar_month_span_exact(s.start_date, v_cutoff))) end;

  if least(v_effective_months, v_head_months) > 0 then
    return query select v_signup_fy, (s.price_at_signup / v_signup_months) * least(v_effective_months, v_head_months);
  end if;
  if greatest(0, v_effective_months - v_head_months) > 0 then
    return query select v_signup_fy + 1, (s.price_at_signup / v_signup_months) * greatest(0, v_effective_months - v_head_months);
  end if;

  -- Each decided renewal term (12 months from renewal_month, at that
  -- renewal's snapshotted price).
  for r in
    select ren.fiscal_year, ren.renewal_price
    from renewals ren
    where ren.subscription_id = s.id and ren.decision = 'opted_in' and ren.renewal_price is not null
  loop
    v_term_start := make_date(
      case when v_renewal_month >= 10 then r.fiscal_year - 1 else r.fiscal_year end,
      v_renewal_month, 1);
    v_term_head_months := fy_boundary_months(v_renewal_month);
    v_term_effective_months := case when v_cutoff is null then 12
      else least(12, greatest(0, calendar_month_span_exact(v_term_start, v_cutoff))) end;

    if least(v_term_effective_months, v_term_head_months) > 0 then
      return query select r.fiscal_year, (r.renewal_price / 12.0) * least(v_term_effective_months, v_term_head_months);
    end if;
    if greatest(0, v_term_effective_months - v_term_head_months) > 0 then
      return query select r.fiscal_year + 1, (r.renewal_price / 12.0) * greatest(0, v_term_effective_months - v_term_head_months);
    end if;
  end loop;
end;
$$;

-- Same signature as 70_team_spend.sql's version — "actual" now comes from
-- subscription_actual_fy_ledger() instead of the old signup_amounts/
-- real_head/real_tail CTEs (which never looked at status at all).
-- "projected" is unchanged.
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
    select es.billing_type_text, sum(ledger.amount) as amount
    from eligible_subs es
    cross join lateral subscription_actual_fy_ledger(es.id) as ledger
    where ledger.fiscal_year = p_fiscal_year
    group by es.billing_type_text
  ),
  projected_amounts as (
    select billing_type_text,
      sum(license_price * 1.10 * fy_boundary_months(coalesce(nullif(renewal_month, 0), 10)) / 12.0) as amount
    from eligible_subs es
    where es.status = 'active'
      and es.billing_cycle = 'annual'
      and es.renewal_reminder = true
      and es.billing_type_text != 'gtis'
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

-- Same shape as get_team_spend(), scoped to the caller's owned SuiteKeys
-- instead of their team, grouped by suite_key instead of billing_type.
-- Returns every key the caller owns, even ones with nothing charged this
-- FY, so the page always shows the full set of keys someone owns.
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
    select es.suite_key, sum(ledger.amount) as amount
    from eligible_subs es
    cross join lateral subscription_actual_fy_ledger(es.id) as ledger
    where ledger.fiscal_year = p_fiscal_year
    group by es.suite_key
  ),
  projected_amounts as (
    select suite_key,
      sum(license_price * 1.10 * fy_boundary_months(coalesce(nullif(renewal_month, 0), 10)) / 12.0) as amount
    from eligible_subs es
    where es.status = 'active'
      and es.billing_cycle = 'annual'
      and es.renewal_reminder = true
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

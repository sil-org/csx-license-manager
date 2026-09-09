-- GTIS-sponsored subscriptions never go through the opt-in renewal flow —
-- start_renewal_period() explicitly excludes billing_type = 'gtis' (nobody
-- has to decide anything, GTIS just keeps paying) — so under
-- subscription_actual_fy_ledger() (71), a GTIS subscription only ever
-- contributed money in the one fiscal year it originally signed up: with no
-- renewals row ever created for it, every later FY saw $0, even for a
-- still-active, years-old subscription that's obviously still costing GTIS
-- money every year.
--
-- Fixes it by giving 'gtis' its own model: instead of the signup-fragment-
-- then-discrete-renewals shape (which assumes a renewals row exists to
-- carry a subscription forward), treat it as a plain ongoing monthly rate —
-- current license price / 12 — for as long as it's active (or, if
-- cancelled/revoked, until the audit_log cutoff date), overlapped with
-- whatever fiscal year is being asked about. No per-renewal price snapshot
-- exists for GTIS (nothing was ever decided/quoted), so this necessarily
-- uses today's license price even for past fiscal years — the same
-- limitation already noted for the pre-71 renewal_price backfill.
--
-- Restructures the shared helper from "return every fiscal year this
-- subscription ever touched" to "return the amount for one specific fiscal
-- year" — simpler for both call sites (they only ever want one FY at a
-- time anyway) and the only way to support GTIS's open-ended, not-tied-to-
-- discrete-events model without an unbounded loop.
drop function if exists subscription_actual_fy_ledger(uuid);

create or replace function subscription_actual_fy_amount(p_subscription_id uuid, p_fiscal_year int)
returns numeric language plpgsql stable as $$
declare
  s subscriptions%rowtype;
  l licenses%rowtype;
  v_cutoff date;
  v_renewal_month int;
  v_signup_months int;
  v_signup_fy int;
  v_head_months int;
  v_effective_months numeric;
  v_amount numeric := 0;
  r record;
  v_term_start date;
  v_term_head_months int;
  v_term_effective_months numeric;
  v_fy_start date;
  v_fy_end date;
  v_overlap_start date;
  v_overlap_end date;
begin
  select * into s from subscriptions where id = p_subscription_id;
  if s.id is null or s.billing_cycle is distinct from 'annual' or s.status = 'declined' then
    return 0;
  end if;

  if s.status in ('cancelled', 'revoked') then
    select max(a.created_at)::date into v_cutoff
    from audit_log a
    where a.subscription_id = s.id and a.action::text = s.status::text;
  end if;

  if s.billing_type = 'gtis' then
    select * into l from licenses where id = s.license_id;
    v_fy_start := make_date(p_fiscal_year - 1, 10, 1);
    v_fy_end := make_date(p_fiscal_year, 10, 1); -- exclusive
    v_overlap_start := greatest(s.start_date, v_fy_start);
    v_overlap_end := least(coalesce(v_cutoff, v_fy_end), v_fy_end);
    if v_overlap_end > v_overlap_start then
      return (l.price / 12.0) * calendar_month_span_exact(v_overlap_start, v_overlap_end);
    end if;
    return 0;
  end if;

  v_renewal_month := coalesce(nullif(s.renewal_month, 0), 10);

  -- Signup fragment: only relevant if it lands in (or spills into) the
  -- requested FY.
  v_signup_months := calendar_month_span(extract(month from s.start_date)::int, v_renewal_month);
  v_signup_fy := case when extract(month from s.start_date) >= 10
    then extract(year from s.start_date)::int + 1
    else extract(year from s.start_date)::int end;

  if v_signup_fy = p_fiscal_year or v_signup_fy + 1 = p_fiscal_year then
    v_head_months := fy_boundary_months(extract(month from s.start_date)::int);
    v_effective_months := case when v_cutoff is null then v_signup_months::numeric
      else least(v_signup_months::numeric, greatest(0, calendar_month_span_exact(s.start_date, v_cutoff))) end;

    if v_signup_fy = p_fiscal_year then
      v_amount := v_amount + (s.price_at_signup / v_signup_months) * least(v_effective_months, v_head_months);
    else
      v_amount := v_amount + (s.price_at_signup / v_signup_months) * greatest(0, v_effective_months - v_head_months);
    end if;
  end if;

  -- Each decided renewal whose term lands in (or spills into) the
  -- requested FY.
  for r in
    select ren.fiscal_year, ren.renewal_price
    from renewals ren
    where ren.subscription_id = s.id and ren.decision = 'opted_in' and ren.renewal_price is not null
      and ren.fiscal_year in (p_fiscal_year, p_fiscal_year - 1)
  loop
    v_term_start := make_date(
      case when v_renewal_month >= 10 then r.fiscal_year - 1 else r.fiscal_year end,
      v_renewal_month, 1);
    v_term_head_months := fy_boundary_months(v_renewal_month);
    v_term_effective_months := case when v_cutoff is null then 12
      else least(12, greatest(0, calendar_month_span_exact(v_term_start, v_cutoff))) end;

    if r.fiscal_year = p_fiscal_year then
      v_amount := v_amount + (r.renewal_price / 12.0) * least(v_term_effective_months, v_term_head_months);
    else
      v_amount := v_amount + (r.renewal_price / 12.0) * greatest(0, v_term_effective_months - v_term_head_months);
    end if;
  end loop;

  return v_amount;
end;
$$;

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

-- Monthly-billed subscriptions counted as $0 in every spend figure.
--
-- subscription_actual_fy_amount() (72) returns 0 for anything whose
-- billing_cycle isn't 'annual', and the "projected" half of get_team_spend()
-- and get_suite_key_spend() also requires billing_cycle = 'annual'. That was a
-- deliberate scoping choice in 71 ("FY isn't a meaningful concept for
-- monthly/one-time subscriptions"), but it means an $8/month license shows
-- $0 actual and $0 projected on SuiteKey Charges and My Team, even though
-- the SuiteKey is being billed every month.
--
-- Fix: give 'monthly' its own model inside the same function, the way 72 did
-- for 'gtis' — an ongoing per-month rate, not a signup-fragment-then-renewals
-- shape (monthly subscriptions never go through the renewal flow, so there
-- are no renewals rows to carry them forward):
--   amount for FY = monthly price x number of billed calendar months that
--   overlap the FY.
--   - Billed months run from the start_date's month (a partial first month
--     bills in full — same "at least one full month" rule as
--     calc_prorated_cost()) up to the FY's end, or, for cancelled/revoked,
--     through the month of the audit_log cutoff date.
--   - Price is price_at_signup (what was actually quoted/charged, area
--     discount included), falling back to the license's current price when
--     it's null (legacy rows; 77 nulls out legacy zeros). 'gtis' has no
--     per-subscription snapshot, so it uses the license's current price, as
--     the annual GTIS model already does.
--   - declined: $0, same as before.
--
-- Because an active monthly subscription is already counted for the whole FY
-- here (just as 'gtis' is), it deliberately has no "projected" amount: there
-- is no pending renewal decision to estimate. The projected queries in
-- get_team_spend()/get_suite_key_spend() are unchanged and still annual-only.
--
-- NOT covered: 'one_time' subscriptions still count as $0 (a single charge in
-- the FY of start_date would be the natural model; left out until asked).
--
-- Signature and return type are unchanged, so create-or-replace keeps the
-- grants applied by 78 and there is no overload to drop. The annual and gtis
-- paths below are copied verbatim from 72.
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
  v_monthly_price numeric;
begin
  select * into s from subscriptions where id = p_subscription_id;
  if s.id is null or s.status = 'declined'
     or s.billing_cycle is null
     or s.billing_cycle not in ('annual', 'monthly') then
    return 0;
  end if;

  if s.status in ('cancelled', 'revoked') then
    select max(a.created_at)::date into v_cutoff
    from audit_log a
    where a.subscription_id = s.id and a.action::text = s.status::text;
  end if;

  -- Monthly: checked before the gtis branch below, which assumes l.price is
  -- an annual figure (price / 12).
  if s.billing_cycle = 'monthly' then
    select * into l from licenses where id = s.license_id;
    v_monthly_price := case when s.billing_type = 'gtis' then l.price
      else coalesce(s.price_at_signup, l.price) end;
    v_fy_start := make_date(p_fiscal_year - 1, 10, 1);
    v_fy_end := make_date(p_fiscal_year, 10, 1); -- exclusive
    -- Whole calendar months: a partial first (or last) month bills in full.
    v_overlap_start := greatest(date_trunc('month', s.start_date)::date, v_fy_start);
    v_overlap_end := least(
      coalesce((date_trunc('month', v_cutoff) + interval '1 month')::date, v_fy_end),
      v_fy_end);
    if v_overlap_end > v_overlap_start and v_monthly_price is not null then
      return v_monthly_price * calendar_month_span_exact(v_overlap_start, v_overlap_end);
    end if;
    return 0;
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

-- Sanity check after applying (read-only): monthly subscriptions should now
-- show a non-zero amount for the current FY.
--   select s.id, l.name, s.price_at_signup,
--          subscription_actual_fy_amount(s.id, 2027) as fy2027
--   from subscriptions s join licenses l on l.id = s.license_id
--   where s.billing_cycle = 'monthly' and s.status <> 'declined';

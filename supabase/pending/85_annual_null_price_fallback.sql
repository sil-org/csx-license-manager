-- Annual subscriptions with a null price_at_signup returned NULL from
-- subscription_actual_fy_amount(), and the NULL swallowed everything after it.
--
-- price_at_signup is null for ~1,500 legacy GAS rows whose price was never
-- recorded (77). In the annual path, `v_amount + (null / months) * ...` is
-- NULL, and every later `v_amount + ...` (the decided-renewal terms, which DO
-- have real prices) stays NULL — so the function returned NULL, sum() skipped
-- the row, and the subscription vanished from SuiteKey Charges / My Team
-- totals even when it had renewals with known prices.
--
-- Fix, consistent with 84's monthly rule: when price_at_signup is null, use
-- the license's current price for the signup fragment (an estimate — the true
-- historical price was never captured). A null on both sides contributes 0
-- instead of poisoning the total. Renewal terms are unchanged and always add
-- to a non-null v_amount now.
--
-- NOTE: this changes existing totals for any owner with legacy null-price
-- annual subscriptions (they go from missing/short to estimated). Apply once
-- Finance is OK with that. Signature/return type unchanged; the monthly and
-- gtis paths are copied verbatim from 84.
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
  v_signup_price numeric;
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

  -- Unknown (null) signup price: estimate from the license's current price;
  -- if that is unknown too, contribute 0 rather than NULLing the whole total.
  select * into l from licenses where id = s.license_id;
  v_signup_price := coalesce(s.price_at_signup, l.price, 0);

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
      v_amount := v_amount + (v_signup_price / v_signup_months) * least(v_effective_months, v_head_months);
    else
      v_amount := v_amount + (v_signup_price / v_signup_months) * greatest(0, v_effective_months - v_head_months);
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

-- Sanity check after applying (read-only): no annual row should return NULL.
--   select s.id, s.price_at_signup, subscription_actual_fy_amount(s.id, 2027) as fy2027
--   from subscriptions s
--   where s.billing_cycle = 'annual' and s.status <> 'declined'
--     and subscription_actual_fy_amount(s.id, 2027) is null;   -- expect 0 rows

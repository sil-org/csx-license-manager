-- Run this in the Supabase SQL Editor. Monthly-billed, pro-rated licenses
-- were charging a sub-month fraction of the price for a partial first
-- month (e.g. signing up on the 30th of a 31-day month billed 2/31 of the
-- price) — floor it so a monthly subscription always bills at least one
-- full month.

create or replace function calc_prorated_cost(
  p_price numeric, p_billing_cycle billing_cycle, p_renewal_month int, p_pro_rated boolean, p_start_date date
) returns numeric language plpgsql immutable as $$
declare
  v_day int;
  v_days_in_month int;
  v_days_left int;
  v_renew_month int;
  v_start_month int;
  v_months int;
begin
  if not p_pro_rated then
    return p_price;
  end if;

  if p_billing_cycle = 'monthly' then
    v_day := extract(day from p_start_date)::int;
    v_days_in_month := extract(day from (date_trunc('month', p_start_date) + interval '1 month - 1 day'))::int;
    v_days_left := v_days_in_month - v_day + 1;
    -- Monthly subscriptions always bill at least one full month, even for a
    -- one- or two-day partial first month — no sub-month proration discount.
    return greatest(round(p_price * v_days_left / v_days_in_month, 2), p_price);
  end if;

  v_renew_month := coalesce(nullif(p_renewal_month, 0), 10);
  v_start_month := extract(month from p_start_date)::int;
  v_months := v_renew_month - v_start_month;
  if v_months <= 0 then
    v_months := v_months + 12;
  end if;
  return round(p_price * v_months / 12, 2);
end;
$$;

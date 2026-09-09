-- My Team spend summary: per-fiscal-year totals by billing_type (suite_key /
-- ministry / gtis — department is intentionally excluded, it's always $0 to
-- the requester) for a manager's own + direct/indirect reports' subscriptions.
--
-- The hard part is that a single subscription's annual cost almost never
-- lines up with the Oct 1 fiscal-year boundary: the license's per-year price
-- is split across the two fiscal years its 12-month term overlaps, same as
-- calc_prorated_cost() already does for the *first* signup fragment. Two
-- pieces feed a requested FY's total:
--   1. "actual" — the exact split of price actually charged:
--      - the signup fragment (price_at_signup), attributed whole to the FY
--        derived from start_date (NOT subscriptions.fy, which opt_in_renewal()
--        overwrites forward on every renewal, so it no longer reflects the
--        year someone originally signed up once they've renewed even once).
--      - for each decided renewal (renewals.decision = 'opted_in'), its
--        renewal_price split between the FY it was decided for (the "head",
--        months from renewal_month to Oct 1) and the following FY (the
--        "tail", the remaining months) — see fy_boundary_months() below.
--   2. "projected" — for eligible subscriptions with no decision yet for the
--      requested FY (no opted_in/opted_out renewals row), a heads-up
--      estimate: current license price + 10%, split the same way. This is
--      never asked for a genuinely closed decision — 'opted_out' subscriptions
--      are excluded outright (not renewing), same for anything not eligible
--      to renew through this flow at all (billing_type = 'gtis', inactive,
--      monthly, or renewal_reminder = false) — mirrors start_renewal_period()'s
--      own eligibility filter exactly.
--
-- renewals never had a price column before this — start_renewal_period()
-- (68_start_renewal_period_full_price.sql) already quotes l.price at
-- decision time but only returns it transiently for the reminder email, so
-- there was nowhere to read an "actual" renewal amount back from later. This
-- adds that snapshot, written by opt_in_renewal() the same way
-- price_at_signup is written at initial request time.
alter table renewals add column if not exists renewal_price numeric;

-- Best-effort backfill for renewals decided before this column existed: the
-- license's *current* price is the closest available stand-in, since the
-- actual historical renewal price was never captured. Only affects reporting
-- on fiscal years old enough to predate this migration.
update renewals r
  set renewal_price = l.price
  from subscriptions s
  join licenses l on l.id = s.license_id
  where r.subscription_id = s.id
    and r.decision = 'opted_in'
    and r.renewal_price is null;

create or replace function opt_in_renewal(p_subscription_id uuid)
returns void language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_sub subscriptions%rowtype;
  v_price numeric;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if not (is_admin() or v_sub.user_email = v_email) then raise exception 'not authorized'; end if;
  if v_sub.open_renewal_fy is null then raise exception 'no open renewal period'; end if;

  select price into v_price from licenses where id = v_sub.license_id;

  update subscriptions
    set fy = v_sub.open_renewal_fy, renewal_status = 'opted_in', open_renewal_fy = null
    where id = p_subscription_id;

  update renewals
    set decision = 'opted_in', decided_at = now(), decided_by = v_email,
        opt_in_date = current_date, opted_in_by = v_email, renewal_price = v_price
    where subscription_id = p_subscription_id and fiscal_year = v_sub.open_renewal_fy;
end;
$$;

-- Months of a 12-month term starting p_month that fall before the Oct 1
-- fiscal-year boundary (the "head"; 12 - this is the "tail" that spills into
-- the following FY). Same mod-12 pattern as calc_prorated_cost() — a term
-- starting exactly in October has a full 12-month head and no tail.
create or replace function fy_boundary_months(p_month int)
returns int language sql immutable as $$
  select case when 10 - coalesce(nullif(p_month, 0), 10) <= 0
    then 10 - coalesce(nullif(p_month, 0), 10) + 12
    else 10 - coalesce(nullif(p_month, 0), 10)
  end
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
  -- Signup fragment: whole amount goes to the FY start_date actually falls
  -- in, not subscriptions.fy (which tracks the *latest* renewal decision).
  signup_amounts as (
    select billing_type_text,
      sum(price_at_signup) as amount
    from eligible_subs
    where (case when extract(month from start_date) >= 10
                then extract(year from start_date)::int + 1
                else extract(year from start_date)::int
           end) = p_fiscal_year
    group by billing_type_text
  ),
  decided_renewals as (
    select r.fiscal_year, r.renewal_price, es.billing_type_text, es.renewal_month
    from renewals r
    join eligible_subs es on es.id = r.subscription_id
    where r.decision = 'opted_in' and r.renewal_price is not null
  ),
  real_head as (
    select billing_type_text,
      sum(renewal_price * fy_boundary_months(renewal_month) / 12.0) as amount
    from decided_renewals
    where fiscal_year = p_fiscal_year
    group by billing_type_text
  ),
  real_tail as (
    select billing_type_text,
      sum(renewal_price * (12 - fy_boundary_months(renewal_month)) / 12.0) as amount
    from decided_renewals
    where fiscal_year = p_fiscal_year - 1
    group by billing_type_text
  ),
  projected_amounts as (
    select billing_type_text,
      sum(license_price * 1.10 * fy_boundary_months(renewal_month) / 12.0) as amount
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
    coalesce((select amount from signup_amounts sa where sa.billing_type_text = c.billing_type_text), 0)
      + coalesce((select amount from real_head rh where rh.billing_type_text = c.billing_type_text), 0)
      + coalesce((select amount from real_tail rt where rt.billing_type_text = c.billing_type_text), 0) as actual,
    coalesce((select amount from projected_amounts pa where pa.billing_type_text = c.billing_type_text), 0) as projected
  from categories c;
$$;

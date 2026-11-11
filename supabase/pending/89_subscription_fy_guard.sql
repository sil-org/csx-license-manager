-- Server-side guard so subscriptions.fy can't be stored below the fiscal year
-- of start_date, whatever client sent it.
--
-- request_subscription() stores p_fy exactly as received, and the table has no
-- check on it. Bad values have come in two ways: a stale copy of the app
-- sending the calendar year after the Oct 1 form fix (834325a) reached
-- production (~32 rows, 2026-10-01 .. 2026-10-28), and two on-behalf requests
-- carrying fy = 27 from a caller that isn't the request form. fy below the FY
-- of start_date is never legitimate: it makes a just-signed-up subscription
-- look due for renewal (start_renewal_period() uses s.fy < the renewal FY) and
-- makes My Subscriptions show the license price instead of the price paid.
--
-- Rule (INSERT only, non-legacy rows): if fy is null or lower than the FY of
-- start_date (FY runs Oct 1 - Sep 30, named for the year it ends in), set it to
-- that FY. fy ABOVE it is left alone: opt_in_renewal() bumps fy upward on
-- renewal, and next-FY requests are allowed in Aug/Sep. Legacy rows (legacy_id
-- set, imported from the GAS sheet) keep whatever fy came over with them.
-- Updates are untouched.
--
-- Also backfills existing rows that already break the rule — idempotent, so it
-- is safe if the same UPDATE was already run by hand.
create or replace function normalize_subscription_fy()
returns trigger language plpgsql set search_path = public as $$
declare
  v_fy int;
begin
  if new.legacy_id is not null or new.start_date is null then
    return new;
  end if;
  v_fy := extract(year from new.start_date)::int
          + (case when extract(month from new.start_date) >= 10 then 1 else 0 end);
  if new.fy is null or new.fy < v_fy then
    new.fy := v_fy;
  end if;
  return new;
end;
$$;

drop trigger if exists subscriptions_normalize_fy on subscriptions;
create trigger subscriptions_normalize_fy
  before insert on subscriptions
  for each row execute function normalize_subscription_fy();

update subscriptions s
set fy = extract(year from s.start_date)::int
         + (case when extract(month from s.start_date) >= 10 then 1 else 0 end)
where s.legacy_id is null
  and s.fy < extract(year from s.start_date)::int
             + (case when extract(month from s.start_date) >= 10 then 1 else 0 end);

-- Sanity check after applying (read-only): trigger present, nothing left to fix.
--   select tgname from pg_trigger
--   where tgrelid = 'subscriptions'::regclass and not tgisinternal;
--   -- expect 0 rows from the earlier mismatch query (fy < FY of start_date, legacy_id is null)

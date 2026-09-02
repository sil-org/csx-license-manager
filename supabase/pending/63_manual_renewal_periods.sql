-- Manual, per-fiscal-year renewal periods.
--
-- Previously: subscriptions.renewal_status flipped once ('none' ->
-- 'opted_in'/'opted_out') and never reset, so there was no way to tell "never
-- asked" from "asked, still waiting," no record of when a reminder went out,
-- and the weekly send-renewal-reminders cron auto-discovered anyone within
-- ~60 days of their renewal_month and emailed them without any admin action.
--
-- Now: an admin explicitly opens a renewal period per license/fiscal-year
-- (start_renewal_period()) before anyone gets asked anything. subscriptions
-- .open_renewal_fy tracks whether a decision is currently pending (and for
-- which FY); the weekly cron keeps nagging only subscriptions with an open
-- period, until opt_in_renewal()/opt_out_renewal() resolves it. renewals
-- becomes the real per-period audit log (send date + decision), not just an
-- opt-in log.

-- ─── subscriptions.open_renewal_fy ─────────────────────────────────────────
-- Non-null while a renewal decision is pending; holds the FY being decided.
-- Replaces renewal_status = 'none' as the "can this person opt in/out right
-- now" signal, which conflated "never asked" with "asked, awaiting answer."
alter table subscriptions add column if not exists open_renewal_fy int;

-- ─── renewals: per-period audit log ────────────────────────────────────────
-- reminder_sent_at is stamped when a period opens. decision/decided_at/
-- decided_by generalize opt_in_date/opted_in_by to cover opt-outs too.
-- opt_in_date/opted_in_by are left as-is (set only on a real opt-in) so
-- get_finance_export's renewed_date lookup (max(opt_in_date)) needs no
-- changes.
alter table renewals add column if not exists reminder_sent_at timestamptz;

alter table renewals add column if not exists decision renewal_status not null default 'opted_in';
-- Every renewals row that existed before this migration was logged only by
-- the old opt_in_renewal(), so backfilling to 'opted_in' above is correct for
-- history; new rows (period-start, opt-out) should default to 'none'.
alter table renewals alter column decision set default 'none';

alter table renewals add column if not exists decided_at timestamptz;
update renewals set decided_at = opt_in_date::timestamptz where decided_at is null;

alter table renewals add column if not exists decided_by text;
update renewals set decided_by = opted_in_by where decided_by is null;

-- Period-start and opt-out rows don't set opt_in_date.
alter table renewals alter column opt_in_date drop not null;
alter table renewals alter column opt_in_date drop default;

-- ─── RPC: start_renewal_period ──────────────────────────────────────────────
-- Admin-only. Opens a renewal period for every eligible active annual
-- subscription of one license, for one fiscal year: stamps
-- subscriptions.open_renewal_fy and inserts a 'none'-decision renewals row.
-- Idempotent — re-running for the same (license, fy) only picks up
-- subscriptions that don't already have a renewals row for that fy, so it
-- never re-opens someone who already opted in/out for this exact year.
-- Returns what the caller needs to send the reminder email itself (this app
-- always sends email from the client via lib/email.js's sendEmail(), never
-- from a write RPC) — see AllSubscriptions.jsx's handleSendRenewalReminder
-- for the single-subscription equivalent this generalizes.
create or replace function start_renewal_period(p_license_id uuid, p_fiscal_year int)
returns table(
  subscription_id uuid, user_email text, license_name text, billing_label text,
  price_at_signup numeric, renewal_month int, reminder_message text
) language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;

  return query
  with opened as (
    update subscriptions s set open_renewal_fy = p_fiscal_year
    where s.license_id = p_license_id
      and s.status = 'active'
      and s.billing_cycle = 'annual'
      and s.renewal_reminder = true
      and s.billing_type != 'gtis'
      and s.open_renewal_fy is null
      and s.fy < p_fiscal_year
      and not exists (
        select 1 from renewals r where r.subscription_id = s.id and r.fiscal_year = p_fiscal_year
      )
    returning s.id, s.user_email, s.suite_key, s.ministry_id, s.billing_type,
      s.price_at_signup, s.renewal_month, s.license_id
  ), logged as (
    insert into renewals (subscription_id, fiscal_year, reminder_sent_at, decision)
    select o.id, p_fiscal_year, now(), 'none' from opened o
    returning subscription_id
  )
  select
    o.id, o.user_email, l.name,
    case
      when o.billing_type = 'gtis' then 'GTIS'
      when o.billing_type = 'ministry' then 'Ministry ID ' || o.ministry_id
      else o.suite_key
    end,
    o.price_at_signup, o.renewal_month, l.reminder_message
  from opened o
  join licenses l on l.id = o.license_id;
end;
$$;

-- ─── RPC: opt_in_renewal / opt_out_renewal (rewritten) ─────────────────────
-- Both now resolve against open_renewal_fy instead of blindly flipping a
-- single status: a decision can only be made while a period is actually
-- open (started via start_renewal_period), never ad-hoc.
create or replace function opt_in_renewal(p_subscription_id uuid)
returns void language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_sub subscriptions%rowtype;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if not (is_admin() or v_sub.user_email = v_email) then raise exception 'not authorized'; end if;
  if v_sub.open_renewal_fy is null then raise exception 'no open renewal period'; end if;

  update subscriptions
    set fy = v_sub.open_renewal_fy, renewal_status = 'opted_in', open_renewal_fy = null
    where id = p_subscription_id;

  update renewals
    set decision = 'opted_in', decided_at = now(), decided_by = v_email,
        opt_in_date = current_date, opted_in_by = v_email
    where subscription_id = p_subscription_id and fiscal_year = v_sub.open_renewal_fy;
end;
$$;

create or replace function opt_out_renewal(p_subscription_id uuid)
returns void language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_sub subscriptions%rowtype;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if not (is_admin() or v_sub.user_email = v_email) then raise exception 'not authorized'; end if;
  if v_sub.open_renewal_fy is null then raise exception 'no open renewal period'; end if;

  update subscriptions
    set renewal_status = 'opted_out', open_renewal_fy = null
    where id = p_subscription_id;

  update renewals
    set decision = 'opted_out', decided_at = now(), decided_by = v_email
    where subscription_id = p_subscription_id and fiscal_year = v_sub.open_renewal_fy;
end;
$$;

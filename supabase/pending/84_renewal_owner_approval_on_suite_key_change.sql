-- Run this in the Supabase SQL Editor.
--
-- When a subscription's SuiteKey changes (admin repoint via
-- admin_update_subscription_suite_key(), or any future user-facing flow), the
-- new key's owner never agreed to pay for it — and a renewal used to go
-- straight through opt_in_renewal() with no approval at all. Now the next
-- renewal opt-in on such a subscription is routed to the NEW key's owner
-- (or group, or the suggested approver while the key is still unclaimed) and
-- only takes effect once they approve it in the Action Center.
--
-- How it works
--   * subscriptions.renewal_needs_owner_approval — set by a trigger whenever
--     suite_key changes. Cleared when an owner approves a renewal. Not set
--     when the old key had no owner (the admin_merge_suite_key() typo-fix
--     case, which only ever merges away unowned keys).
--   * renewals.awaiting_owner_approval / requested_by — the parked opt-in.
--     open_renewal_fy stays set and decision stays 'none' until the owner acts.
--   * opt_in_renewal() parks instead of renewing when the flag is set and the
--     caller isn't themselves the key's owner.
--   * approve_renewal() / decline_renewal() — owner (or admin) completes or
--     rejects the parked renewal. Decline behaves like an opt-out.
--   * get_my_pending_renewal_approvals() — feeds the Action Center.
--
-- opt_in_renewal()/opt_out_renewal() keep their signatures, so CREATE OR
-- REPLACE preserves grants; the new functions are granted explicitly below.

alter table subscriptions add column if not exists renewal_needs_owner_approval boolean not null default false;
alter table renewals add column if not exists awaiting_owner_approval boolean not null default false;
alter table renewals add column if not exists requested_by text;

-- ─── Trigger: flag SuiteKey changes ────────────────────────────────────────────
create or replace function flag_renewal_on_suite_key_change()
returns trigger language plpgsql security definer as $$
begin
  if new.suite_key is distinct from old.suite_key
     and new.billing_type = 'suite_key'
     and old.suite_key is not null
     and exists (
       select 1 from suite_keys sk
       where sk.suite_key = old.suite_key
         and (sk.owner_email is not null or sk.owner_group_email is not null)
     ) then
    new.renewal_needs_owner_approval := true;
  end if;
  return new;
end;
$$;

drop trigger if exists subscriptions_flag_renewal_on_suite_key_change on subscriptions;
create trigger subscriptions_flag_renewal_on_suite_key_change
  before update of suite_key on subscriptions
  for each row execute function flag_renewal_on_suite_key_change();

-- ─── Helper: may the caller approve renewals against this key? ─────────────────
-- Owner (individual or group member) or the still-unclaimed key's pending
-- suggested approver. Admins are handled by the callers.
create or replace function can_approve_renewal_for_key(p_suite_key text)
returns boolean language sql stable security definer as $$
  select p_suite_key is not null and (
    is_suite_key_owner(p_suite_key)
    or exists (
      select 1 from suite_keys sk
      where sk.suite_key = p_suite_key
        and sk.owner_email is null and sk.owner_group_email is null
        and (
          lower(sk.pending_owner_email) = lower(current_profile_email())
          or (sk.pending_owner_is_group and exists (
            select 1 from group_memberships gm
            where gm.group_email = sk.pending_owner_email
              and lower(gm.member_email) = lower(current_profile_email())
          ))
        )
    )
  )
$$;

-- ─── opt_in_renewal ────────────────────────────────────────────────────────────
create or replace function opt_in_renewal(p_subscription_id uuid)
returns void language plpgsql security definer as $$
declare
  v_email text := require_profile_email();
  v_sub subscriptions%rowtype;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if not coalesce((is_admin() or v_sub.user_email = v_email), false) then raise exception 'not authorized'; end if;
  if v_sub.open_renewal_fy is null then raise exception 'no open renewal period'; end if;

  -- SuiteKey changed since the owner last signed off: park the renewal for the
  -- current key's owner instead of applying it. (If the caller IS that owner,
  -- there's nobody else to ask.)
  if v_sub.renewal_needs_owner_approval and not can_approve_renewal_for_key(v_sub.suite_key) then
    update renewals
      set awaiting_owner_approval = true, requested_by = v_email
      where subscription_id = p_subscription_id and fiscal_year = v_sub.open_renewal_fy;
    return;
  end if;

  update subscriptions
    set fy = v_sub.open_renewal_fy, renewal_status = 'opted_in', open_renewal_fy = null,
        renewal_needs_owner_approval = false
    where id = p_subscription_id;

  update renewals
    set decision = 'opted_in', decided_at = now(), decided_by = v_email,
        opt_in_date = current_date, opted_in_by = v_email, awaiting_owner_approval = false
    where subscription_id = p_subscription_id and fiscal_year = v_sub.open_renewal_fy;
end;
$$;

-- ─── opt_out_renewal: also withdraws a parked opt-in ───────────────────────────
create or replace function opt_out_renewal(p_subscription_id uuid)
returns void language plpgsql security definer as $$
declare
  v_email text := require_profile_email();
  v_sub subscriptions%rowtype;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if not coalesce((is_admin() or v_sub.user_email = v_email), false) then raise exception 'not authorized'; end if;
  if v_sub.open_renewal_fy is null then raise exception 'no open renewal period'; end if;

  update subscriptions
    set renewal_status = 'opted_out', open_renewal_fy = null
    where id = p_subscription_id;

  update renewals
    set decision = 'opted_out', decided_at = now(), decided_by = v_email, awaiting_owner_approval = false
    where subscription_id = p_subscription_id and fiscal_year = v_sub.open_renewal_fy;
end;
$$;

-- ─── approve_renewal / decline_renewal ─────────────────────────────────────────
create or replace function approve_renewal(p_subscription_id uuid)
returns table(user_email text, license_name text, suite_key text, fiscal_year int)
language plpgsql security definer as $$
declare
  v_email text := require_profile_email();
  v_sub subscriptions%rowtype;
  v_ren renewals%rowtype;
  v_license_name text;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  select * into v_ren from renewals r
    where r.subscription_id = p_subscription_id and r.fiscal_year = v_sub.open_renewal_fy and r.awaiting_owner_approval;
  if v_ren.id is null then raise exception 'no renewal is awaiting approval on this subscription'; end if;
  if not coalesce((is_admin() or can_approve_renewal_for_key(v_sub.suite_key)), false) then
    raise exception 'not authorized to approve this renewal';
  end if;

  update subscriptions
    set fy = v_ren.fiscal_year, renewal_status = 'opted_in', open_renewal_fy = null,
        renewal_needs_owner_approval = false
    where id = p_subscription_id;

  update renewals
    set decision = 'opted_in', decided_at = now(), decided_by = v_email,
        opt_in_date = current_date, opted_in_by = coalesce(v_ren.requested_by, v_sub.user_email),
        awaiting_owner_approval = false
    where id = v_ren.id;

  select l.name into v_license_name from licenses l where l.id = v_sub.license_id;
  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
  values ('approved', p_subscription_id, v_license_name, v_sub.user_email, v_sub.suite_key, v_email,
          'renewal for FY' || v_ren.fiscal_year || ' approved by SuiteKey owner', current_client_ip());

  return query select v_sub.user_email, v_license_name, v_sub.suite_key, v_ren.fiscal_year;
end;
$$;

create or replace function decline_renewal(p_subscription_id uuid, p_notes text default null)
returns table(user_email text, license_name text, suite_key text, fiscal_year int)
language plpgsql security definer as $$
declare
  v_email text := require_profile_email();
  v_sub subscriptions%rowtype;
  v_ren renewals%rowtype;
  v_license_name text;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  select * into v_ren from renewals r
    where r.subscription_id = p_subscription_id and r.fiscal_year = v_sub.open_renewal_fy and r.awaiting_owner_approval;
  if v_ren.id is null then raise exception 'no renewal is awaiting approval on this subscription'; end if;
  if not coalesce((is_admin() or can_approve_renewal_for_key(v_sub.suite_key)), false) then
    raise exception 'not authorized to decline this renewal';
  end if;

  -- Same end state as the requester opting out.
  update subscriptions set renewal_status = 'opted_out', open_renewal_fy = null where id = p_subscription_id;
  update renewals
    set decision = 'opted_out', decided_at = now(), decided_by = v_email, awaiting_owner_approval = false
    where id = v_ren.id;

  select l.name into v_license_name from licenses l where l.id = v_sub.license_id;
  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
  values ('declined', p_subscription_id, v_license_name, v_sub.user_email, v_sub.suite_key, v_email,
          'renewal for FY' || v_ren.fiscal_year || ' declined by SuiteKey owner' || coalesce(': ' || nullif(trim(p_notes), ''), ''),
          current_client_ip());

  return query select v_sub.user_email, v_license_name, v_sub.suite_key, v_ren.fiscal_year;
end;
$$;

-- ─── get_my_pending_renewal_approvals ──────────────────────────────────────────
-- Same scoping rule as get_my_pending_approvals(): not admin-inclusive, only
-- what the caller can personally act on.
create or replace function get_my_pending_renewal_approvals()
returns table(id uuid, user_email text, suite_key text, license_name text, fiscal_year int)
language sql stable security definer as $$
  select s.id, s.user_email, s.suite_key, l.name, r.fiscal_year
  from renewals r
  join subscriptions s on s.id = r.subscription_id and s.open_renewal_fy = r.fiscal_year
  join licenses l on l.id = s.license_id
  where r.awaiting_owner_approval
    and can_approve_renewal_for_key(s.suite_key)
  order by r.reminder_sent_at nulls last
$$;

-- ─── Grants (match 78_critical_auth_hardening.sql) ─────────────────────────────
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'approve_renewal', 'decline_renewal', 'get_my_pending_renewal_approvals', 'can_approve_renewal_for_key'
    )
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated, service_role', r.sig);
  end loop;
end $$;

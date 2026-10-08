-- Critical auth hardening (2026-09-25 security review). Closes five holes that
-- together let anyone holding the public anon key, or any signed-in user of
-- any app on this shared Supabase project, act as an admin:
--
--   1. NULL in an authorization guard meant "allowed": plpgsql's IF treats a
--      NULL condition as false, so `if not (...) then raise` skips the raise
--      whenever the expression is NULL. is_admin() returned NULL for callers
--      with no profile (so every `if not is_admin()` passed for anon), and
--      approve/decline_subscription's `v_sub.pending_approver_email = v_email`
--      is NULL for every ordinary suite-key request (no pending approver) —
--      so ANY signed-in user could approve or decline any pending request.
--   2. resolve_profile() trusted the caller-supplied p_supabase_user_id and
--      p_email, so any signed-in user could link their account to any
--      existing profile (an admin's included) just by naming its email.
--   3. linked_accounts' insert policy was `with check (true)` — same
--      takeover, via a direct table insert.
--   4. profiles' own-update policy only protected `role`, so a user could
--      rewrite their own primary_email/manager_email/sco — and nearly every
--      authorization check in this app is keyed on email.
--   5. Every function was executable by anon (Postgres grants EXECUTE to
--      PUBLIC on create; the earlier `revoke ... from anon, authenticated`
--      statements in 51-54 never removed that PUBLIC grant).
--
-- Safe to re-run. resolve_profile() keeps its exact signature, so the
-- helpdesk app (same project, same function) keeps working unchanged — but
-- its own copy of schema.sql must get the same fix, or re-running that file
-- reintroduces hole #2.
--
-- NOTE for every future migration: new functions in `public` are again
-- executable by anon by default (project-wide default privileges, shared
-- with other apps, so deliberately not changed here). Any new RPC must end
-- with `revoke execute on function ... from public, anon;` — or re-run
-- section 5 below.

-- ─── 1. is_admin() never returns NULL ────────────────────────────────────────

create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(get_profile_role() = 'admin', false)
$$;

-- Guard for RPCs that authorize by comparing against the caller's email:
-- raises instead of letting a NULL email turn `not (... or x = NULL)` into
-- NULL, which plpgsql's IF treats as false (i.e. "authorized").
create or replace function require_profile_email()
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_email text := current_profile_email();
begin
  if v_email is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  return v_email;
end;
$$;

-- ─── 2. resolve_profile() derives identity from the session ──────────────────
-- p_supabase_user_id/p_email/p_display_name are still accepted (so existing
-- clients in this app and the helpdesk app don't break) but ignored:
-- identity comes from auth.uid() and that user's auth.users row, which only
-- the auth server can write. New-profile creation (case 3) additionally
-- requires a confirmed email, so an unconfirmed email/password sign-up can't
-- claim an existing staff profile by address.

create or replace function resolve_profile(
  p_token uuid,
  p_supabase_user_id uuid,
  p_email text,
  p_display_name text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_confirmed_at timestamptz;
  v_display_name text;
  v_profile_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;

  select u.email, u.email_confirmed_at,
         coalesce(nullif(u.raw_user_meta_data->>'full_name', ''), nullif(u.raw_user_meta_data->>'name', ''), u.email)
    into v_email, v_confirmed_at, v_display_name
  from auth.users u where u.id = v_uid;
  if v_email is null then raise exception 'signed-in account has no email address'; end if;

  -- case 1: already linked
  select profile_id into v_profile_id
  from linked_accounts where supabase_user_id = v_uid;
  if v_profile_id is not null then
    return v_profile_id;
  end if;

  -- case 2: valid link token — links this account to the token's profile
  -- regardless of email domain (the token itself is the proof). Locked so
  -- two concurrent sign-ins can't both redeem the same token.
  if p_token is not null then
    select profile_id into v_profile_id
    from profile_link_tokens
    where token = p_token and used_at is null and expires_at > now()
    for update;

    if v_profile_id is not null then
      insert into linked_accounts (supabase_user_id, profile_id, email)
      values (v_uid, v_profile_id, v_email);
      update profile_link_tokens set used_at = now() where token = p_token;
      return v_profile_id;
    end if;
  end if;

  -- case 3: new person, or first sign-in for a pre-created placeholder profile.
  if not is_eligible_staff_email(v_email) then
    raise exception 'Access restricted to SIL staff.';
  end if;
  if v_confirmed_at is null then
    raise exception 'email address not confirmed';
  end if;

  select id into v_profile_id from profiles where lower(primary_email) = lower(v_email);
  if v_profile_id is not null then
    update profiles set display_name = v_display_name where id = v_profile_id;
  else
    insert into profiles (display_name, primary_email)
    values (v_display_name, v_email)
    returning id into v_profile_id;
  end if;

  insert into linked_accounts (supabase_user_id, profile_id, email)
  values (v_uid, v_profile_id, v_email);

  return v_profile_id;
end;
$$;

-- ─── 3. No direct inserts into linked_accounts ───────────────────────────────
-- resolve_profile() is security definer and doesn't need this policy.

drop policy if exists "linked_accounts: insert own" on linked_accounts;

-- ─── 4. Users can't rewrite identity/org columns on their own profile ────────
-- The own-update policy stays (display_name edits are fine); this trigger
-- rejects changes to authorization-relevant columns when the write comes
-- directly from a client role. Security-definer RPCs (admin_set_role, the
-- importers, resolve_profile) run as the function owner and are unaffected.
-- Columns are compared via to_jsonb so a column that doesn't exist (e.g.
-- department, dropped in 60) is just a no-op instead of an error.

create or replace function profiles_block_self_escalation()
returns trigger language plpgsql set search_path = public as $$
declare
  k text;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  foreach k in array array['id', 'primary_email', 'role', 'manager_email', 'sco', 'job_title', 'department'] loop
    if (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
      raise exception 'profiles.% can only be changed by an administrator', k using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists profiles_block_self_escalation on profiles;
create trigger profiles_block_self_escalation
  before update on profiles
  for each row execute function profiles_block_self_escalation();

-- ─── 5. Function EXECUTE grants ──────────────────────────────────────────────
-- Revoke from PUBLIC and anon on every function this app defines, then grant
-- back to authenticated/service_role. Two exceptions:
--   - Functions referenced by RLS policies must stay executable by whoever
--     runs the query (including anon, e.g. the announcements banner), so
--     they're left alone. They only answer questions about the caller, and
--     with fix #1 they answer "no" for anon.
--   - The Pipedream-only SuiteKey sync functions get service_role only.
-- Explicit name list (not "all functions in schema public") because this
-- project is shared with other apps whose functions must not be touched.

do $$
declare
  v_rpcs text[] := array[
    'activate_subscription', 'admin_add_area_discount', 'admin_add_department_approval',
    'admin_confirm_sk_ownership', 'admin_import_audit_log', 'admin_import_licenses',
    'admin_import_sco_codes', 'admin_import_subscriptions', 'admin_import_subscriptions_full',
    'admin_import_team_hierarchy', 'admin_list_area_discounts', 'admin_list_areas',
    'admin_list_department_approvals', 'admin_merge_suite_key', 'admin_remove_area_discount',
    'admin_remove_department_approval', 'admin_save_announcement', 'admin_set_role',
    'admin_update_ministry_id', 'admin_update_subscription_suite_key', 'admin_update_suite_key_owner',
    'approve_subscription', 'calc_prorated_cost', 'calendar_month_span', 'calendar_month_span_exact',
    'cancel_subscription', 'confirm_sk_ownership', 'create_link_token', 'current_client_ip',
    'deactivate_license', 'decline_subscription', 'deny_sk_ownership', 'fy_boundary_months',
    'get_admin_emails', 'get_area_discounted_price', 'get_finance_export', 'get_last_team_import',
    'get_my_pending_approvals', 'get_my_pending_provisioning', 'get_my_pending_sk_verifications',
    'get_my_suite_keys', 'get_seat_provisioning_fields', 'get_suite_key_owner', 'get_suite_key_spend',
    'get_team_spend', 'is_eligible_staff_email', 'is_manager_of', 'is_org_manager',
    'is_service_manager_any', 'is_suite_key_owner_any', 'opt_in_renewal', 'opt_out_renewal',
    'reactivate_license', 'request_subscription', 'require_profile_email', 'resolve_profile',
    'revoke_subscription', 'save_license', 'search_suite_keys', 'start_renewal_period',
    'subscription_actual_fy_amount', 'update_subscription_details'
  ];
  v_service_only text[] := array['refresh_suite_keys_current', 'reconcile_suite_keys_from_current'];
  r record;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(v_rpcs || v_service_only)
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
    if r.proname = any(v_service_only) then
      execute format('revoke execute on function %s from authenticated', r.sig);
      execute format('grant execute on function %s to service_role', r.sig);
    else
      execute format('grant execute on function %s to authenticated, service_role', r.sig);
    end if;
  end loop;
end $$;

-- ─── 6. Sender attribution for send-email ────────────────────────────────────
-- send-email now requires a verified caller; record who it was.

alter table email_log add column if not exists sent_by text;

-- ─── 7. Guard every RPC that authorizes by the caller's email ────────────────
-- Each body below is the latest existing definition copied verbatim, with two
-- mechanical changes only:
--   - `current_profile_email()` -> `require_profile_email()` in the declare
--     block (plus an explicit call in update_subscription_details, which has
--     no v_email), so a caller with no profile is rejected up front.
--   - every `if not (<expr>) then raise` guard becomes
--     `if not coalesce((<expr>), false) then raise`, so a NULL anywhere in
--     the expression denies instead of allowing.
-- Any new guard must use the same coalesce(..., false) form.

-- approve_subscription: latest body from supabase/pending/40_department_gated_licenses.sql; only change is the guard.
create or replace function approve_subscription(p_subscription_id uuid)
returns void language plpgsql security definer as $$
declare
  v_email text := require_profile_email();
  v_sub subscriptions%rowtype;
  v_license licenses%rowtype;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status != 'pending' then raise exception 'subscription is not pending approval'; end if;
  if not coalesce((is_admin() or is_suite_key_owner(v_sub.suite_key) or v_sub.pending_approver_email = v_email), false) then
    raise exception 'not authorized to approve this subscription';
  end if;

  select * into v_license from licenses where id = v_sub.license_id;

  -- Owner approval only clears the SuiteKey-ownership (or, now, department-
  -- approver) gate — it never skips provisioning. No license is
  -- auto-provisioned today, so this always lands on 'approved' and relies on
  -- buildProvisioningNotifications() (see src/lib/subscriptions.js) firing
  -- off the "someone needs to provision this" email, same as
  -- request_subscription()'s auto-approved paths.
  update subscriptions set status = 'approved' where id = p_subscription_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, ip_address)
  values ('approved', p_subscription_id, v_license.name, v_sub.user_email, v_sub.suite_key, v_email, current_client_ip());
end;
$$;

-- decline_subscription: latest body from supabase/pending/18_audit_ip_tracking.sql; only change is the guard.
create or replace function decline_subscription(p_subscription_id uuid, p_notes text default null)
returns void language plpgsql security definer as $$
declare
  v_email text := require_profile_email();
  v_sub subscriptions%rowtype;
  v_license_name text;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status not in ('pending', 'pending_sk_verification') then
    raise exception 'subscription is not awaiting approval';
  end if;
  if not coalesce((
    is_admin()
    or (v_sub.suite_key is not null and is_suite_key_owner(v_sub.suite_key))
    or v_sub.pending_approver_email = v_email
  ), false) then
    raise exception 'not authorized to decline this subscription';
  end if;

  select name into v_license_name from licenses where id = v_sub.license_id;
  update subscriptions set status = 'declined' where id = p_subscription_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
  values ('declined', p_subscription_id, v_license_name, v_sub.user_email, v_sub.suite_key, v_email, p_notes, current_client_ip());
end;
$$;

-- activate_subscription: latest body from supabase/pending/38_service_manager_multi_and_email_fields.sql; only change is the guard.
create or replace function activate_subscription(p_subscription_id uuid, p_price numeric default null)
returns void language plpgsql security definer as $$
declare
  v_email text := require_profile_email();
  v_sub subscriptions%rowtype;
  v_license licenses%rowtype;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status != 'approved' then raise exception 'subscription is not approved'; end if;

  select * into v_license from licenses where id = v_sub.license_id;
  if not coalesce((is_admin() or v_email = any(v_license.service_manager_emails)), false) then
    raise exception 'not authorized to activate this subscription';
  end if;

  update subscriptions
  set status = 'active', activated_at = current_date, price_at_signup = coalesce(p_price, price_at_signup)
  where id = p_subscription_id;

  -- Google Group membership (when licenses.google_group_email is set) is
  -- handled asynchronously by sync-provisioning's google_group pass, kicked
  -- from the same UI action that calls this RPC — see
  -- supabase/functions/sync-provisioning/adapters/google-group.ts.
  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, ip_address)
  values ('activated', p_subscription_id, v_license.name, v_sub.user_email, v_sub.suite_key, v_email, current_client_ip());
end;
$$;

-- cancel_subscription: latest body from supabase/pending/57_manager_and_suite_key_owner_revoke.sql; only change is the guard.
create or replace function cancel_subscription(p_subscription_id uuid, p_reason text default null)
returns void language plpgsql security definer as $$
declare
  v_email text := require_profile_email();
  v_sub subscriptions%rowtype;
  v_license_name text;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status not in ('pending', 'pending_sk_verification', 'approved', 'active') then
    raise exception 'subscription cannot be cancelled from its current status';
  end if;
  -- is_manager_of() covers My Team's "Cancel" button — a people manager
  -- cancelling a direct/indirect report's subscription.
  if not coalesce((is_admin() or v_sub.user_email = v_email or is_service_manager_for(v_sub.license_id) or is_manager_of(v_sub.user_email)), false) then
    raise exception 'not authorized to cancel this subscription';
  end if;

  select name into v_license_name from licenses where id = v_sub.license_id;
  update subscriptions set status = 'cancelled' where id = p_subscription_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
  values ('cancelled', p_subscription_id, v_license_name, v_sub.user_email, v_sub.suite_key, v_email, p_reason, current_client_ip());
end;
$$;

-- revoke_subscription: latest body from supabase/pending/57_manager_and_suite_key_owner_revoke.sql; only change is the guard.
create or replace function revoke_subscription(p_subscription_id uuid, p_reason text default null)
returns void language plpgsql security definer as $$
declare
  v_email text := require_profile_email();
  v_sub subscriptions%rowtype;
  v_license_name text;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status != 'active' then raise exception 'subscription is not active'; end if;
  if not coalesce((is_admin() or (v_sub.suite_key is not null and is_suite_key_owner(v_sub.suite_key))), false) then
    raise exception 'not authorized to revoke this subscription';
  end if;

  select name into v_license_name from licenses where id = v_sub.license_id;
  update subscriptions set status = 'revoked' where id = p_subscription_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
  values ('revoked', p_subscription_id, v_license_name, v_sub.user_email, v_sub.suite_key, v_email, p_reason, current_client_ip());
end;
$$;

-- opt_in_renewal: latest body from supabase/pending/70_team_spend.sql; only change is the guard.
create or replace function opt_in_renewal(p_subscription_id uuid)
returns void language plpgsql security definer as $$
declare
  v_email text := require_profile_email();
  v_sub subscriptions%rowtype;
  v_price numeric;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if not coalesce((is_admin() or v_sub.user_email = v_email), false) then raise exception 'not authorized'; end if;
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

-- opt_out_renewal: latest body from supabase/pending/63_manual_renewal_periods.sql; only change is the guard.
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
    set decision = 'opted_out', decided_at = now(), decided_by = v_email
    where subscription_id = p_subscription_id and fiscal_year = v_sub.open_renewal_fy;
end;
$$;

-- deny_sk_ownership: latest body from supabase/pending/59_group_suggested_approver.sql; only change is the guard.
create or replace function deny_sk_ownership(p_suite_key text)
returns table(id uuid, user_email text, license_name text)
language plpgsql security definer as $$
declare
  v_email text := require_profile_email();
  v_approver text;
begin
  select pending_approver_email into v_approver
  from subscriptions
  where suite_key = p_suite_key and status = 'pending_sk_verification' and pending_approver_email = v_email
  limit 1;

  if v_approver is null then
    select s.pending_approver_email into v_approver
    from subscriptions s
    where s.suite_key = p_suite_key and s.status = 'pending_sk_verification' and s.pending_approver_is_group
      and exists (
        select 1 from group_memberships gm
        where gm.group_email = s.pending_approver_email and lower(gm.member_email) = v_email
      )
    limit 1;
  end if;

  insert into audit_log (action, suite_key, performed_by, notes, ip_address)
  values ('declined', p_suite_key, v_email, 'suite key ownership declined', current_client_ip());

  return query
    update subscriptions s
    set status = 'declined'
    from licenses l
    where s.suite_key = p_suite_key and s.status = 'pending_sk_verification'
      and s.pending_approver_email = v_approver and l.id = s.license_id
    returning s.id, s.user_email, l.name;
end;
$$;

-- update_subscription_details: latest body from supabase/pending/49_license_extra_field_and_price_unit.sql; only change is the guard.
create or replace function update_subscription_details(
  p_subscription_id uuid, p_notes text, p_product_key text, p_invoice_number text, p_price_paid numeric,
  p_extra_field_value text default null
) returns void language plpgsql security definer as $$
declare
  v_sub subscriptions%rowtype;
begin
  perform require_profile_email();
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if not coalesce((is_admin() or is_service_manager_for(v_sub.license_id)), false) then
    raise exception 'not authorized to edit this subscription';
  end if;

  update subscriptions set
    notes = nullif(trim(p_notes), ''),
    product_key = nullif(trim(p_product_key), ''),
    invoice_number = nullif(trim(p_invoice_number), ''),
    price_at_signup = p_price_paid,
    extra_field_value = nullif(trim(p_extra_field_value), '')
  where id = p_subscription_id;
end;
$$;


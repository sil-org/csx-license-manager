-- ─── LICENSE MANAGER — DOMAIN SCHEMA ─────────────────────────────────────────
-- Run this AFTER supabase/schema.sql (the auth kernel: profiles, linked
-- accounts, resolve_profile). Ported from the original Google Apps Script /
-- Sheets version — see /gas-legacy for the source this was modeled on.
--
-- STILL NOT ported (see README.md's "What's not ported yet" for full detail):
--   - Emails.gs: outbound email is wired up (Resend, send-email Edge
--     Function), but doesn't actually send until infra finishes Resend's
--     domain setup.
--   - Google Group membership sync on activate/revoke (Approvals.gs) — the
--     license's own Google Group, not SuiteKey ownership groups (those work).
--     Needs an Edge Function calling the Admin SDK Directory API; noted with
--     a TODO in activate_subscription()'s audit note.
--   - Provisioning.gs's Gmail-inbox scanning automation — GAS-specific
--     housekeeping with no direct equivalent; drop or reimplement as a
--     scheduled job against Gmail's API if still needed.
--
-- Since ported: Catalog.gs's finance export and bulk CSV import
-- (calc_prorated_cost/get_finance_export, admin_import_subscriptions below),
-- and Managers.gs's org-hierarchy "my team's subscriptions" view
-- (get_report_emails, My Team page).
--
-- Since added, with no GAS equivalent: requesting a subscription on behalf
-- of someone else (request_subscription()'s p_recipient_email); adapter-based
-- automated provisioning (provisioning_adapter/provisioning_config,
-- supabase/functions/sync-provisioning); department-gated licensing
-- (department_approvals); per-license Terms & Conditions acknowledgement
-- (requires_acknowledgement); and the Workday-derived org-hierarchy CSV
-- import (admin_import_team_hierarchy) feeding profiles.manager_email/sco/
-- job_title.

-- ─── ENUMS ───────────────────────────────────────────────────────────────────

-- Postgres has no CREATE TYPE IF NOT EXISTS, and this whole file is meant to
-- be safely re-runnable (it's the living source of truth, re-applied as new
-- pending/*.sql migrations get folded in) — so each enum is guarded with a
-- do-block that swallows "already exists" instead of erroring. On a fresh
-- database these all just create the type normally.
do $$ begin
  create type subscription_status as enum (
    'pending_sk_verification', 'pending', 'approved', 'active',
    'declined', 'revoked', 'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type renewal_status as enum ('none', 'opted_in', 'opted_out');
exception when duplicate_object then null; end $$;

-- renewal_month/renewal_reminder are only meaningful for 'annual' billing.
-- 'one_time' is for non-recurring purchases (e.g. an OS license bought
-- outright) and never renews; 'monthly' prorates by day-of-month instead
-- (see calc_prorated_cost() below) rather than renewing on a calendar month.
-- Both should be left null/false — nothing enforces that at the DB level,
-- the admin UI just hides those fields unless 'annual' is selected.
do $$ begin
  create type billing_cycle as enum ('annual', 'monthly', 'one_time');
exception when duplicate_object then null; end $$;

do $$ begin
  create type audit_action as enum (
    'requested', 'auto_approved', 'approved', 'declined',
    'activated', 'revoked', 'cancelled', 'sk_verified', 'imported', 'sk_merged'
  );
exception when duplicate_object then null; end $$;

alter type audit_action add value if not exists 'suite_key_updated';

-- Which billing path a subscription used. Replaces the original GAS-ported
-- design of overloading suite_key with the literal strings 'GTIS' /
-- 'MIN:XXXXXX' — that broke the suite_key FK below, since neither value is
-- ever a real row in suite_keys. suite_key/ministry_id are only populated
-- for their matching billing_type; both are null for 'gtis'.
do $$ begin
  create type subscription_billing_type as enum ('suite_key', 'gtis', 'ministry');
exception when duplicate_object then null; end $$;

-- 'free' means nobody pays ($0 licenses, e.g. department-gated Gemini).
-- It was added as 'department' (40) and renamed in 80 — department approval
-- is a gate on the license (licenses.department_gated + department_approvals),
-- not a way of paying.
alter type subscription_billing_type add value if not exists 'free';

-- ─── PROFILE EXTENSIONS ──────────────────────────────────────────────────────
-- Needed so RPCs below can join subscriptions/licenses (keyed by email) back
-- to a profile. The base template's profiles.primary_email has no unique
-- constraint; add one here since this app relies on email-based lookups.

alter table profiles add column if not exists department text;
alter table profiles add column if not exists manager_email text;
-- sco/job_title/employee_type/staff_id come from the same Workday-derived
-- org-hierarchy CSV import as manager_email (see
-- admin_import_team_hierarchy() below) — sco is a 3-letter org code, the
-- rest are free text.
alter table profiles add column if not exists sco text;
alter table profiles add column if not exists job_title text;
alter table profiles add column if not exists employee_type text;
alter table profiles add column if not exists staff_id text;
create unique index if not exists profiles_primary_email_idx on profiles (lower(primary_email));

-- ─── TABLES ──────────────────────────────────────────────────────────────────

-- Cost-center / budget keys. owner_email is null until someone claims it via
-- confirm_sk_ownership() (the "suite key verification" flow). owner_email and
-- owner_group_email are mutually exclusive — a key is owned by one individual
-- OR by anyone currently in a Google Group, never both (admin_update_suite_key_owner()
-- enforces this). Group ownership skips the self-service verification step
-- entirely, since an admin assigning a group is already an authoritative
-- claim — see is_suite_key_owner() and request_subscription() below.
create table if not exists suite_keys (
  suite_key       text primary key,
  owner_email     text,
  owner_group_email text,
  description     text,
  created_at      timestamptz not null default now(),
  -- A key-level pending ownership claim — set by
  -- admin_update_subscription_suite_key() when an admin repoints a
  -- subscription onto a SuiteKey with no owner on file and supplies a
  -- suggested approver. Distinct from subscriptions.pending_approver_email
  -- (which gates that one subscription's own status): this can't live on
  -- the subscription, since that RPC deliberately never changes the
  -- subscription's status. admin_confirm_sk_ownership()/
  -- admin_update_suite_key_owner() resolve and clear these once ownership
  -- is actually established.
  pending_owner_email    text,
  pending_owner_is_group boolean not null default false
);

-- Belt-and-suspenders against the class of bug where a case-mismatched
-- SuiteKey (e.g. "relations-u_sil" vs "Relations-U_SIL") silently creates a
-- second, unowned row instead of matching the real one. request_subscription()
-- and admin_update_suite_key_owner() both normalize to the existing row's
-- casing before writing, but this index turns any path that doesn't into a
-- loud constraint error instead of quietly corrupting data.
create unique index if not exists suite_keys_lower_suite_key_idx on suite_keys (lower(suite_key));

-- Cache of Google Group membership, refreshed on a schedule by the
-- sync-group-memberships Edge Function (a service account assigned a
-- Workspace admin role directly, narrowly scoped to
-- admin.directory.group[.member].readonly).
-- RLS can't make live calls to Google's API, so authorization checks read
-- this cache rather than querying Directory API per-request. Populated for
-- groups referenced as a suite_keys.owner_group_email, and (since
-- pending_approver_is_group) also for any group named as a suite key's
-- suggested approver while still awaiting confirmation — never a sync of
-- the whole organization's group directory.
create table if not exists group_memberships (
  group_email  text not null,
  member_email text not null,
  synced_at    timestamptz not null default now(),
  primary key (group_email, member_email)
);

-- Self-owned billing IDs (bypass suite-key approval entirely).
create table if not exists ministry_ids (
  email       text primary key,
  ministry_id text not null unique
);

-- Software catalog.
create table if not exists licenses (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  vendor               text,
  category             text,
  price                numeric,
  price_unit           text,
  notes                text,
  active               boolean not null default true,
  gtis_sponsored       boolean not null default false,
  billing_cycle        billing_cycle not null default 'annual',
  renewal_month        int check (renewal_month between 1 and 12),
  renewal_reminder     boolean not null default true,
  created_by           uuid references profiles(id),
  logo_url             text,
  activation_url       text,   -- presence means "needs admin/service-manager provisioning"
  more_info_url        text,
  google_group_email   text,
  pro_rated            boolean not null default false,
  service_manager_emails text[] not null default '{}',   -- multi-recipient; was a single service_manager_email text column pre-38
  onboarding_message   text,   -- overrides the default "your license is ready" activation email body for this license
  reminder_message     text,   -- overrides the default renewal-reminder card body for this license (weekly digest sender not built yet — see README)
  provisioning_adapter text,   -- null = manual (today's behavior); e.g. 'cubebackup'
  provisioning_config  jsonb,  -- adapter-specific settings, e.g. {"domain": "sil.org"}
  provisioning_lock_until timestamptz,   -- concurrency guard: sync-provisioning claims a license before processing it, so an overlapping run skips rather than double-calling the vendor's API
  provisioning_email_show_name boolean not null default false,
  provisioning_email_show_job_title boolean not null default false,
  provisioning_email_show_department boolean not null default false,
  department_gated    boolean not null default false,   -- gate approval on the recipient's own department (see department_approvals) instead of a suite key
  requires_acknowledgement boolean not null default false,   -- requester must acknowledge acknowledgement_text before requesting
  acknowledgement_text text,
  extra_field_label    text,   -- null = no extra field; set = RequestModal asks for one more piece of text at request time (e.g. "Shared Drive name")
  extra_field_required boolean not null default false,   -- only meaningful when extra_field_label is set
  allow_multiple_per_person boolean not null default false,   -- lets one person hold more than one subscription to this license in the same FY (e.g. multiple Shared Drives) — bypasses request_subscription()'s one-per-person-per-FY guard
  receiving_suite_key  text not null default 'WaxhawIT-U_SIL',   -- the suite key that receives this license's charges; editable in Admin -> Catalog's "More settings". Plain text, not an FK to suite_keys — it's a destination, not a billed-to key with an owner
  legacy_id            text,   -- GAS Licenses sheet's ID (e.g. "LIC-XXXXXXXX"), set only by admin_import_licenses()
  created_at           timestamptz not null default now()
);

create unique index if not exists licenses_legacy_id_idx on licenses (legacy_id) where legacy_id is not null;

-- Subscription / request records.
create table if not exists subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  user_email            text not null,
  license_id            uuid not null references licenses(id),
  suite_key             text references suite_keys(suite_key),
  billing_type          subscription_billing_type not null default 'suite_key',
  ministry_id           text references ministry_ids(ministry_id),
  start_date            date not null default current_date,
  activated_at          date,   -- when the subscription actually went active (seat provisioned) — distinct from start_date, which is the request date and drives billing/proration
  fy                    int not null,
  status                subscription_status not null default 'pending',
  renewal_status        renewal_status not null default 'none',
  -- Non-null while a renewal decision is pending, holding the FY being
  -- decided — set by start_renewal_period(), cleared by opt_in_renewal()/
  -- opt_out_renewal(). Distinct from renewal_status = 'none', which can also
  -- mean "never asked" (no period has ever been opened).
  open_renewal_fy       int,
  billing_cycle         billing_cycle,
  renewal_month         int,
  renewal_reminder      boolean,
  pending_approver_email text,
  -- True when pending_approver_email is a Google Group address rather than
  -- an individual — set at request time by request_subscription() (based on
  -- a Directory API classification done client-side before submitting, see
  -- classify-approver-email Edge Function). Changes how confirmation is
  -- matched: get_my_pending_sk_verifications()/confirm_sk_ownership()/
  -- deny_sk_ownership() accept any current member of the named group
  -- (via group_memberships), not just an exact profile-email match — see
  -- 2026-09-01's operations_gslt@sil.org / alan_yam@sil.org incident, where
  -- a group address typed into "suggested approver" could never satisfy the
  -- individual exact-match check no matter who in that group signed in.
  pending_approver_is_group boolean not null default false,
  price_at_signup       numeric,
  requested_by          uuid references profiles(id),
  legacy_id             text,   -- GAS Subscriptions sheet's ID (e.g. "SUB-XXXXXXXX"), set only by admin_import_subscriptions_full()
  notes                 text,   -- free-text admin annotation, distinct from licenses.notes (the catalog-item note)
  product_key           text,
  invoice_number        text,   -- notes/product_key/invoice_number/price_at_signup are all set together via update_subscription_details()
  extra_field_value     text,   -- requester's answer to licenses.extra_field_label, captured at request time; editable after via update_subscription_details()
  -- Set by flag_renewal_on_suite_key_change() when suite_key changes on an
  -- owned key — routes the next renewal opt-in to the new key's owner for
  -- approval (approve_renewal()/decline_renewal()) instead of applying it
  -- straight away. Cleared once that owner acts.
  renewal_needs_owner_approval boolean not null default false,
  created_at            timestamptz not null default now()
);

create index if not exists subscriptions_user_email_idx on subscriptions (user_email);
create index if not exists subscriptions_suite_key_idx on subscriptions (suite_key);
create index if not exists subscriptions_license_id_idx on subscriptions (license_id);
create unique index if not exists subscriptions_legacy_id_idx on subscriptions (legacy_id) where legacy_id is not null;

-- Per-fiscal-year renewal period log: one row per (subscription, fy) opened
-- by start_renewal_period(), tracking when the reminder went out and what
-- was decided. opt_in_date/opted_in_by are set only on a real opt-in (kept
-- around because get_finance_export's renewed_date reads max(opt_in_date));
-- decision/decided_at/decided_by are the general-purpose equivalent that
-- also covers opt-outs and the still-undecided ('none') state.
create table if not exists renewals (
  id             uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  fiscal_year    int not null,
  reminder_sent_at timestamptz,
  decision       renewal_status not null default 'none',
  decided_at     timestamptz,
  decided_by     text,
  opt_in_date    date,
  opted_in_by    text,
  -- A renewal opt-in parked because the subscription's SuiteKey changed
  -- since the owner last signed off — see
  -- flag_renewal_on_suite_key_change()/opt_in_renewal() below. requested_by
  -- is who actually clicked opt-in; decided_by/opt_in_date still record
  -- whoever (the owner) completes it via approve_renewal().
  awaiting_owner_approval boolean not null default false,
  requested_by   text,
  unique (subscription_id, fiscal_year)
);

-- Immutable audit trail. Only ever inserted into, by the RPCs below.
create table if not exists audit_log (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  action         audit_action not null,
  subscription_id uuid references subscriptions(id),
  license_name   text,
  user_email     text,
  suite_key      text,
  performed_by   text,
  notes          text,
  ip_address     text,   -- performed_by's IP at request time; null for historical/imported rows and anything not run via PostgREST (see current_client_ip())
  legacy_id      text    -- GAS AuditLog sheet's ID (e.g. "AUD-XXXXXXXX"), set only by admin_import_audit_log()
);

create unique index if not exists audit_log_legacy_id_idx on audit_log (legacy_id) where legacy_id is not null;

-- Delivery log for the send-email Edge Function (Resend). Written by that
-- function using the service-role key; not written to directly by RPCs.
create table if not exists email_log (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  to_email       text not null,
  subject        text not null,
  template       text not null,
  subscription_id uuid references subscriptions(id),
  resend_id      text,
  status         text not null,
  error          text,
  sent_by        text   -- verified caller: their email, or 'system' for service-role calls
);
alter table email_log add column if not exists sent_by text;

create index if not exists email_log_subscription_id_idx on email_log (subscription_id);

create index if not exists audit_log_subscription_id_idx on audit_log (subscription_id);
create index if not exists audit_log_suite_key_idx on audit_log (suite_key);

-- Delivery log for the sync-provisioning Edge Function — one row per
-- enable/disable/error outcome. Mirrors email_log's shape/RLS style: text
-- status/action columns rather than enums, since dispatch logic lives in the
-- Edge Function's adapter modules, not in Postgres.
create table if not exists provisioning_log (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  license_id     uuid references licenses(id),
  adapter        text not null,
  email          text not null,
  action         text not null, -- 'enabled' | 'disabled'
  external_id    text,
  status         text not null, -- 'ok' | 'failed'
  error          text
);

create index if not exists provisioning_log_license_id_idx on provisioning_log (license_id);

-- Audit trail for the weekly Workday-derived org-hierarchy CSV import (feeds
-- profiles.manager_email/sco/job_title) — just enough for the My Team page to
-- show "last imported on X" without granting non-admins direct select access.
create table if not exists team_hierarchy_imports (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  performed_by text not null,
  row_count    int not null
);

-- Per-license, per-department opt-in for department-gated licensing (an
-- otherwise-free license that still needs a named approver for specific
-- departments' seats) — see request_subscription()'s department_gated branch.
create table if not exists department_approvals (
  id             uuid primary key default gen_random_uuid(),
  license_id     uuid not null references licenses(id),
  sco            text not null check (sco ~ '^[A-Z]{3}$'),
  approver_email text not null,
  created_at     timestamptz not null default now(),
  unique (license_id, sco)
);

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────────────

alter table suite_keys enable row level security;
alter table ministry_ids enable row level security;
alter table licenses enable row level security;
alter table subscriptions enable row level security;
alter table renewals enable row level security;
alter table audit_log enable row level security;
alter table email_log enable row level security;
alter table group_memberships enable row level security;
alter table provisioning_log enable row level security;
alter table team_hierarchy_imports enable row level security;
alter table department_approvals enable row level security;

-- Helpers

create or replace function current_profile_email()
returns text language sql stable security definer as $$
  select primary_email from profiles where id = current_profile_id()
$$;

create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(get_profile_role() = 'admin', false)
$$;

-- Authorization guards in this file must never let NULL mean "allowed":
-- plpgsql's IF treats a NULL condition as false, so `if not (...) then raise`
-- skips the raise when <expr> is NULL. Write guards as
-- `if not coalesce((...), false) then raise`, and resolve the caller with
-- require_profile_email() (raises for a caller with no profile) rather than
-- current_profile_email() (returns NULL). See pending/78.
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

-- Every RPC/RLS policy that gates on Suite Key ownership calls this one
-- helper, so extending it to cover group ownership cascades everywhere
-- (approve/decline/revoke, the subscriptions/renewals/audit_log RLS
-- policies) without touching each call site individually.
create or replace function is_suite_key_owner(p_suite_key text)
returns boolean language sql stable security definer as $$
  select exists(
    select 1 from suite_keys sk
    where sk.suite_key = p_suite_key
      and (
        sk.owner_email = current_profile_email()
        or (
          sk.owner_group_email is not null
          and exists(
            select 1 from group_memberships gm
            where gm.group_email = sk.owner_group_email
              and gm.member_email = current_profile_email()
          )
        )
      )
  )
$$;

create or replace function is_service_manager_for(p_license_id uuid)
returns boolean language sql stable security definer as $$
  select exists(
    select 1 from licenses
    where id = p_license_id and current_profile_email() = any(service_manager_emails)
  )
$$;

create or replace function is_service_manager_any()
returns boolean language sql stable security definer as $$
  select exists(select 1 from licenses where current_profile_email() = any(service_manager_emails))
$$;

create or replace function is_suite_key_owner_any()
returns boolean language sql stable security definer as $$
  select exists(select 1 from suite_keys where owner_email = current_profile_email())
$$;

-- Direct + indirect reports of the current user, walking profiles.manager_email
-- recursively — replicates Managers.gs's getReportEmails(). Used both by the
-- subscriptions RLS policy below and by the My Team page to know who to query for.
create or replace function get_report_emails()
returns setof text language sql stable security definer as $$
  with recursive reports as (
    select lower(p.primary_email) as email
    from profiles p
    where lower(p.manager_email) = lower(current_profile_email())
    union
    select lower(p.primary_email)
    from profiles p
    join reports r on lower(p.manager_email) = r.email
  )
  select email from reports
$$;

create or replace function is_org_manager()
returns boolean language sql stable security definer as $$
  select exists(select 1 from profiles where lower(manager_email) = lower(current_profile_email()))
$$;

-- Is p_email one of the current user's direct/indirect reports — backs
-- cancel_subscription()'s manager authorization (My Team's "Cancel" button).
-- Reuses get_report_emails() rather than re-walking manager_email itself, so
-- the two stay in lockstep by construction.
create or replace function is_manager_of(p_email text)
returns boolean language sql stable security definer as $$
  select lower(p_email) in (select get_report_emails())
$$;

-- Best-effort caller IP for audit_log, read from the request headers Supabase's
-- PostgREST layer exposes as the 'request.headers' GUC (a JSON blob of every
-- HTTP header on the current request). Prefers cf-connecting-ip (set by
-- Cloudflare, in front of Supabase's hosted API) since it's a single
-- unspoofable value; falls back to the first hop of x-forwarded-for otherwise.
-- Returns null rather than raising when called outside a PostgREST request
-- (e.g. the SQL Editor) or if the header is missing/malformed — an audit
-- write should never fail just because the IP couldn't be determined.
create or replace function current_client_ip()
returns text language plpgsql stable as $$
declare
  v_headers json;
  v_xff text;
begin
  begin
    v_headers := current_setting('request.headers', true)::json;
  exception when others then
    return null;
  end;
  if v_headers is null then return null; end if;
  if v_headers->>'cf-connecting-ip' is not null then
    return v_headers->>'cf-connecting-ip';
  end if;
  v_xff := v_headers->>'x-forwarded-for';
  if v_xff is not null and v_xff <> '' then
    return trim(split_part(v_xff, ',', 1));
  end if;
  return null;
end;
$$;

-- Policies
--
-- Postgres has no CREATE POLICY IF NOT EXISTS either, so each is preceded by
-- a matching DROP POLICY IF EXISTS (which Postgres does support) — same
-- re-runnability goal as the enum guards above.

drop policy if exists "suite_keys: owner or admin read" on suite_keys;
create policy "suite_keys: owner or admin read" on suite_keys for select
  using (is_suite_key_owner(suite_key) or is_admin());
drop policy if exists "suite_keys: admin write" on suite_keys;
create policy "suite_keys: admin write" on suite_keys for insert with check (is_admin());
drop policy if exists "suite_keys: admin update" on suite_keys;
create policy "suite_keys: admin update" on suite_keys for update using (is_admin());

drop policy if exists "group_memberships: admin read" on group_memberships;
create policy "group_memberships: admin read" on group_memberships for select using (is_admin());
-- No client write policy — only sync-group-memberships (service-role key) writes here.

drop policy if exists "ministry_ids: own or admin read" on ministry_ids;
create policy "ministry_ids: own or admin read" on ministry_ids for select
  using (email = current_profile_email() or is_admin());

drop policy if exists "licenses: read active, or own scope" on licenses;
create policy "licenses: read active, or own scope" on licenses for select
  using (active or is_admin() or current_profile_email() = any(service_manager_emails));
drop policy if exists "licenses: admin write" on licenses;
create policy "licenses: admin write" on licenses for all
  using (is_admin()) with check (is_admin());

drop policy if exists "subscriptions: read own or authority" on subscriptions;
create policy "subscriptions: read own or authority" on subscriptions for select
  using (
    user_email = current_profile_email()
    or is_admin()
    or (suite_key is not null and is_suite_key_owner(suite_key))
    or is_service_manager_for(license_id)
    or lower(user_email) in (select get_report_emails())
    -- Lets the actor who requested a license for someone else read back the
    -- row they just created via the security-definer request_subscription()
    -- RPC, even when the recipient isn't their direct report. Without this,
    -- requestSubscription()'s post-insert re-select (subscriptions.js) hits
    -- 0 rows under RLS and .single() throws PGRST116, even though the
    -- subscription itself was created successfully.
    or requested_by = current_profile_id()
    -- Lets a department approver (pending_approver_email — see
    -- department_gated licenses, pending/40) read back a row they just
    -- acted on. approve_subscription()/decline_subscription() already
    -- authorize the write via this same field; without the matching read
    -- clause, the client-side re-select in approveSubscription()/
    -- declineSubscription() (src/lib/approvals.js) that builds the
    -- notification email hits 0 rows under RLS and .single() throws
    -- PGRST116 "cannot coerce the result to a single JSON object" — see
    -- pending/69_department_approver_readback.sql.
    or pending_approver_email = current_profile_email()
  );
-- All writes go through the security-definer RPCs below, which enforce
-- status-transition and authority checks themselves; no direct write
-- policies are needed for non-admins.
drop policy if exists "subscriptions: admin write" on subscriptions;
create policy "subscriptions: admin write" on subscriptions for all
  using (is_admin()) with check (is_admin());

drop policy if exists "renewals: read via subscription" on renewals;
create policy "renewals: read via subscription" on renewals for select
  using (
    exists (
      select 1 from subscriptions s where s.id = subscription_id
        and (s.user_email = current_profile_email() or is_admin()
             or (s.suite_key is not null and is_suite_key_owner(s.suite_key)))
    )
  );

drop policy if exists "audit_log: admin read all" on audit_log;
create policy "audit_log: admin read all" on audit_log for select using (is_admin());
drop policy if exists "audit_log: suite key owner read own" on audit_log;
create policy "audit_log: suite key owner read own" on audit_log for select
  using (suite_key is not null and is_suite_key_owner(suite_key));
drop policy if exists "audit_log: user read own" on audit_log;
create policy "audit_log: user read own" on audit_log for select
  using (user_email = current_profile_email());

drop policy if exists "email_log: admin read" on email_log;
create policy "email_log: admin read" on email_log for select using (is_admin());
-- No insert/update policies for authenticated — only the send-email Edge
-- Function writes here, via the service-role key (which bypasses RLS).

drop policy if exists "provisioning_log: admin read" on provisioning_log;
create policy "provisioning_log: admin read" on provisioning_log for select using (is_admin());
-- No insert/update policies for authenticated — only sync-provisioning
-- (service-role key) writes here.

drop policy if exists "team_hierarchy_imports: admin read" on team_hierarchy_imports;
create policy "team_hierarchy_imports: admin read" on team_hierarchy_imports for select
  using (is_admin());

drop policy if exists "department_approvals: admin only" on department_approvals;
create policy "department_approvals: admin only" on department_approvals for all
  using (is_admin()) with check (is_admin());

-- ─── RPC: request_subscription ────────────────────────────────────────────────
-- Mirrors Subscriptions.gs createSubscription(). Branches on GTIS-sponsored /
-- ministry-ID / suite-key paths to decide the initial status.

-- Adds a 6th parameter, so the old 5-arg overload must be dropped explicitly —
-- CREATE OR REPLACE only replaces a function with an identical argument list.
drop function if exists request_subscription(uuid, text, text, text, int);
-- Adds a 7th parameter (p_acknowledged) — same reason, drop the 6-arg overload.
drop function if exists request_subscription(uuid, text, text, text, int, text);
-- Adds an 8th parameter (p_extra_field_value) — same reason, drop the 7-arg overload.
drop function if exists request_subscription(uuid, text, text, text, int, text, boolean);
-- Adds a 9th parameter (p_suggested_approver_is_group) — same reason, drop the 8-arg overload.
drop function if exists request_subscription(uuid, text, text, text, int, text, boolean, text);

create or replace function request_subscription(
  p_license_id uuid,
  p_suite_key text,
  p_suggested_approver_email text,
  p_ministry_id text,
  p_fy int,
  p_recipient_email text default null,
  p_acknowledged boolean default false,
  p_extra_field_value text default null,
  -- Classified client-side (classify-approver-email Edge Function, a
  -- Directory API groups.get lookup) before this RPC is called — Postgres
  -- can't make that call itself. Only meaningful when this lands in the
  -- "unclaimed suite key" branch below; ignored otherwise.
  p_suggested_approver_is_group boolean default false
) returns uuid language plpgsql security definer as $$
declare
  v_license licenses%rowtype;
  -- Mirrors GAS's requesterEmail/recipientEmail split (createSubscription()) —
  -- ownership/auto-approval checks below key off the actor actually signed
  -- in and submitting the request, never the recipient, so "request for
  -- someone else" can't be used to forge approval you don't actually have.
  v_actor_email text := current_profile_email();
  v_recipient_email text := coalesce(nullif(trim(lower(p_recipient_email)), ''), current_profile_email());
  v_sub_id uuid;
  v_status subscription_status;
  v_billing_type subscription_billing_type;
  v_suite_key text := null;
  v_ministry_id text := null;
  v_audit_suite_key text;  -- display-only label for the audit log; NOT written to subscriptions.suite_key
  v_canonical_key text;
  v_owner text;
  v_owner_group text;
  v_pending_approver text := null;
  v_is_group boolean := false;
  v_sco text;
begin
  if v_actor_email is null then raise exception 'not authenticated'; end if;
  if not is_eligible_staff_email(v_recipient_email) then
    raise exception 'License requests are only available to SIL staff.';
  end if;

  select * into v_license from licenses where id = p_license_id and active;
  if v_license.id is null then raise exception 'license not found or inactive'; end if;

  if v_license.requires_acknowledgement and not coalesce(p_acknowledged, false) then
    raise exception 'you must acknowledge the terms & conditions for this license before requesting it';
  end if;

  if v_license.extra_field_required and nullif(trim(p_extra_field_value), '') is null then
    raise exception '% is required for this license', coalesce(v_license.extra_field_label, 'this field');
  end if;

  if not v_license.allow_multiple_per_person and exists (
    select 1 from subscriptions
    where user_email = v_recipient_email and license_id = p_license_id and fy = p_fy
      and status not in ('declined', 'revoked', 'cancelled')
  ) then
    raise exception 'a subscription for this license already exists for this fiscal year';
  end if;

  if v_license.gtis_sponsored then
    v_billing_type := 'gtis';
    v_audit_suite_key := 'GTIS';
    v_status := 'approved';

  elsif v_license.department_gated then
    -- Gate on the recipient's own department, not the requester's — a
    -- department's opt-in should apply to whoever will actually use the
    -- seat, regardless of who happened to submit the request on their
    -- behalf. No profile, or no sco on file, or no opt-in row for that sco:
    -- auto-approve, same as gtis_sponsored.
    v_billing_type := 'free';
    select sco into v_sco from profiles where lower(primary_email) = v_recipient_email;
    if v_sco is not null then
      select approver_email into v_pending_approver
      from department_approvals where license_id = p_license_id and sco = v_sco;
    end if;
    v_audit_suite_key := 'DEPT:' || coalesce(v_sco, 'none');
    if v_pending_approver is not null then
      v_status := 'pending';
    else
      v_pending_approver := null;
      v_status := 'approved';
    end if;

  elsif p_ministry_id is not null then
    if p_ministry_id !~ '^\d{6}$' then
      raise exception 'ministry ID must be exactly 6 digits';
    end if;
    v_billing_type := 'ministry';
    v_ministry_id := p_ministry_id;
    v_audit_suite_key := 'MIN:' || p_ministry_id;
    insert into ministry_ids (email, ministry_id) values (v_recipient_email, p_ministry_id)
      on conflict (email) do update set ministry_id = excluded.ministry_id;
    v_status := 'approved';

  else
    v_billing_type := 'suite_key';
    if p_suite_key is null then raise exception 'a suite key is required'; end if;
    -- Trim here to match admin_update_suite_key_owner()'s trim before its
    -- suite_keys upsert — a stray leading/trailing space on this insert
    -- would otherwise create a row that upsert can never match again later,
    -- since Postgres treats "key" and "key " as distinct primary key text.
    -- Anything from "~" onward is stray pasted text, not part of the real
    -- key (e.g. "Relations-U_SIL~5407") — ignore it rather than rejecting
    -- the whole entry, same as admin_import_subscriptions_full() already
    -- does for legacy data.
    v_suite_key := regexp_replace(trim(p_suite_key), '~.*$', '');
    if v_suite_key = '' then raise exception 'a suite key is required'; end if;

    -- Match case-insensitively, but if a row already exists, normalize to
    -- its actual stored casing (not whatever case the requester happened to
    -- type) — e.g. typing "relations-u_sil" must land on the existing
    -- "Relations-U_SIL" row, not silently create a second, unowned one that
    -- looks identical at a glance. This is the same duplicate-row failure
    -- mode as the earlier whitespace bug, just triggered by case instead.
    select suite_key, owner_email, owner_group_email into v_canonical_key, v_owner, v_owner_group
    from suite_keys where lower(suite_key) = lower(v_suite_key);
    if v_canonical_key is not null then
      v_suite_key := v_canonical_key;
    end if;
    v_audit_suite_key := v_suite_key;

    if v_canonical_key is null then
      insert into suite_keys (suite_key, owner_email) values (v_suite_key, null);
      v_owner := null;
      v_owner_group := null;
    end if;

    if v_owner_group is not null then
      -- Group-owned: no verification step, ever — an admin assigning a group
      -- is already an authoritative claim, and current membership itself is
      -- the authorization check (is_suite_key_owner() below covers this).
      if exists (
        select 1 from group_memberships where group_email = v_owner_group and lower(member_email) = lower(v_actor_email)
      ) then
        v_status := 'approved';
      else
        v_status := 'pending';
      end if;

    -- Unified check: a suite key with no row at all, or an existing row
    -- with no owner claimed yet, both require a suggested approver —
    -- mirrors GAS's `!skExists || !skOwnerEmail` condition. Previously this
    -- only checked the "no row" case, so an existing-but-unclaimed key could
    -- reach pending_sk_verification with pending_approver_email left null.
    elsif v_owner is null then
      if p_suggested_approver_email is null then
        raise exception 'suite key % has no owner on file — provide a suggested approver email', v_suite_key;
      end if;
      v_pending_approver := nullif(lower(trim(p_suggested_approver_email)), '');
      -- lower(v_actor_email): current_profile_email() returns whatever case
      -- Google's OAuth handed back at signup, not normalized — every other
      -- comparison in this function (and admin_update_suite_key_owner,
      -- admin_confirm_sk_ownership, get_report_emails, sync-group-memberships'
      -- own write path) lowercases both sides first; this one and the
      -- "already-owns-it" check below didn't, so an owner/approver match
      -- could silently fall through to 'pending'/'pending_sk_verification'
      -- over a pure case difference (e.g. an admin-typed owner email in
      -- different case than that person's actual Google-account casing).
      if v_pending_approver = lower(v_actor_email) then
        -- The signed-in requester is suggesting themselves as this
        -- unclaimed key's owner — no point parking this in
        -- pending_sk_verification and emailing them a link to confirm a
        -- claim they're already making right now as the authenticated
        -- actor. Register them as owner immediately and fall through to
        -- the same outcome as the "already-owns-it" branch below, instead
        -- of a self-addressed confirmation email that's easy to miss (see
        -- request-for-others RLS gap notes elsewhere in this file).
        update suite_keys set owner_email = lower(v_actor_email) where suite_key = v_suite_key;
        insert into audit_log (action, suite_key, performed_by, ip_address)
        values ('sk_verified', v_suite_key, v_actor_email, current_client_ip());
        v_status := 'approved';
        v_pending_approver := null;
      else
        v_status := 'pending_sk_verification';
        v_is_group := coalesce(p_suggested_approver_is_group, false);
      end if;
    elsif lower(v_owner) = lower(v_actor_email) then
      v_status := 'approved';
    else
      v_status := 'pending';
    end if;
  end if;

  -- activated_at is never set here — every path above lands on 'approved'
  -- at most, never 'active'. No license is auto-provisioned today (see
  -- activate_subscription()), so becoming active always requires an
  -- explicit "Mark active" from an admin/service manager, which is also
  -- what triggers the provisioning-required notification below.
  insert into subscriptions (
    user_email, license_id, suite_key, billing_type, ministry_id, fy, status, billing_cycle,
    renewal_month, renewal_reminder, price_at_signup, pending_approver_email, pending_approver_is_group, requested_by, extra_field_value
  ) values (
    v_recipient_email, p_license_id, v_suite_key, v_billing_type, v_ministry_id, p_fy, v_status, v_license.billing_cycle,
    v_license.renewal_month, v_license.renewal_reminder, v_license.price, v_pending_approver, v_is_group, current_profile_id(),
    nullif(trim(p_extra_field_value), '')
  ) returning id into v_sub_id;

  -- Always log the request itself, even when it's about to be auto-approved
  -- below — otherwise an auto-approved subscription's audit trail starts
  -- with 'auto_approved' and never shows that a request happened at all.
  -- The "on behalf of" and "acknowledged T&C" notes are independent and both
  -- append when applicable, rather than one replacing the other.
  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
  values (
    'requested', v_sub_id, v_license.name, v_recipient_email, v_audit_suite_key, v_actor_email,
    nullif(trim(concat_ws(
      '; ',
      case when v_recipient_email <> v_actor_email then 'on behalf of ' || v_recipient_email else null end,
      case when v_license.requires_acknowledgement then 'acknowledged terms & conditions' else null end
    )), ''),
    current_client_ip()
  );

  if v_status = 'approved' then
    insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, ip_address)
    values ('auto_approved', v_sub_id, v_license.name, v_recipient_email, v_audit_suite_key, v_actor_email, current_client_ip());
  end if;

  return v_sub_id;
end;
$$;

-- ─── RPC: confirm_sk_ownership / deny_sk_ownership ────────────────────────────

-- Both of these now return the subscriptions they just advanced (id, the
-- subscriber's email, license name) instead of void, so the caller knows
-- who to email — see src/lib/email.js. Changing the return type requires
-- dropping the old version first (see the DROP statements above each).

drop function if exists confirm_sk_ownership(text);

create or replace function confirm_sk_ownership(p_suite_key text)
returns table(id uuid, user_email text, license_name text, more_info_url text)
language plpgsql security definer as $$
declare
  v_email text := require_profile_email();
  -- What this suite key's pending_sk_verification row(s) actually name as
  -- the approver — the caller's own email for an individual suggestion, or
  -- a group's address when the caller is just a current member of it (see
  -- pending_approver_is_group). Prefer the exact-match individual case
  -- first so today's common path is untouched; only fall back to "is the
  -- caller a member of a suggested group" when no row names them directly.
  v_approver text;
  v_is_group boolean;
  v_current_owner text;
begin
  select pending_approver_email, false into v_approver, v_is_group
  from subscriptions
  where suite_key = p_suite_key and status = 'pending_sk_verification' and pending_approver_email = v_email
  limit 1;

  if v_approver is null then
    select s.pending_approver_email, true into v_approver, v_is_group
    from subscriptions s
    where s.suite_key = p_suite_key and s.status = 'pending_sk_verification' and s.pending_approver_is_group
      and exists (
        select 1 from group_memberships gm
        where gm.group_email = s.pending_approver_email and lower(gm.member_email) = v_email
      )
    limit 1;
  end if;

  if v_approver is null then
    raise exception 'no request on suite key % is waiting for your confirmation — it may already have been confirmed or denied; reload the page', p_suite_key;
  end if;

  -- Also succeeds if already owned by the resolved approver (idempotent) —
  -- an admin may have already assigned this key via
  -- admin_update_suite_key_owner(), in which case this just
  -- confirms/advances re-pointed requests, not claiming an unowned key.
  if v_is_group then
    update suite_keys set owner_group_email = v_approver, owner_email = null
    where suite_key = p_suite_key and owner_email is null and (owner_group_email is null or owner_group_email = v_approver);
  else
    update suite_keys set owner_email = v_approver, owner_group_email = null
    where suite_key = p_suite_key and (owner_email is null or owner_email = v_approver);
  end if;

  -- Distinct from the "nothing waiting on you" case above — see
  -- 82_confirm_sk_ownership_distinct_errors.sql.
  if not found then
    select coalesce(owner_email, owner_group_email) into v_current_owner
    from suite_keys where suite_key = p_suite_key;
    if v_current_owner is null then
      raise exception 'suite key % does not exist', p_suite_key;
    end if;
    raise exception 'suite key % is already owned by % — ask them or an admin to handle this request', p_suite_key, v_current_owner;
  end if;

  insert into audit_log (action, suite_key, performed_by, notes, ip_address)
  values (
    'sk_verified', p_suite_key, v_email,
    case when v_is_group then 'confirmed as a current member of ' || v_approver else null end,
    current_client_ip()
  );

  return query
    update subscriptions s
    set status = 'pending', pending_approver_email = null, pending_approver_is_group = false
    from licenses l
    where s.suite_key = p_suite_key and s.status = 'pending_sk_verification'
      and s.pending_approver_email = v_approver and l.id = s.license_id
    returning s.id, s.user_email, l.name, l.more_info_url;
end;
$$;

-- ─── RPC: admin_confirm_sk_ownership ────────────────────────────────────────────
-- The "Confirm as {suggested approver}" quick-confirm button in Admin: SuiteKeys
-- needs this, NOT admin_update_suite_key_owner(). That RPC is for "an admin is
-- assigning/correcting who owns this key" — it deliberately leaves affected
-- subscriptions in pending_sk_verification, since the new owner still has to
-- confirm themselves (they may not even know yet). Quick-confirm means the
-- opposite: the suggested approver already confirmed out-of-band (email,
-- verbally), so this should behave like confirm_sk_ownership() itself — advance
-- matching subscriptions straight to 'pending' — just triggered by an admin on
-- that person's behalf instead of by the person signing in.
--
-- Scoped to s.pending_approver_email = p_owner_email specifically (mirrors
-- confirm_sk_ownership()'s own scoping) — admin_update_suite_key_owner()'s
-- blanket "every pending_sk_verification row on this suite_key" match is what
-- let one click silently touch a different requester's unrelated pending
-- request that happened to share the same suite_key with a different
-- suggested approver.

drop function if exists admin_confirm_sk_ownership(text, text);

create or replace function admin_confirm_sk_ownership(p_suite_key text, p_owner_email text)
returns table(id uuid, user_email text, license_name text, more_info_url text)
language plpgsql security definer as $$
declare
  v_owner text := nullif(lower(trim(p_owner_email)), '');
  v_admin text := current_profile_email();
  -- p_owner_email is whatever the quick-confirm button showed, i.e. the
  -- pending_approver_email value verbatim — that can itself be a Google
  -- Group address (pending_approver_is_group), in which case the claim
  -- belongs on owner_group_email, not owner_email.
  v_is_group boolean;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  p_suite_key := trim(p_suite_key);
  if v_owner is null then raise exception 'owner email is required'; end if;

  select bool_or(pending_approver_is_group) into v_is_group
  from subscriptions
  where suite_key = p_suite_key and status = 'pending_sk_verification' and pending_approver_email = v_owner;

  -- No subscription was waiting on this — check for a key-level pending
  -- claim instead (admin_update_subscription_suite_key(), which can't park
  -- the claim on a subscription's own status since it never changes it).
  if v_is_group is null then
    select pending_owner_is_group into v_is_group
    from suite_keys where suite_key = p_suite_key and pending_owner_email = v_owner;
  end if;

  if coalesce(v_is_group, false) then
    update suite_keys set owner_group_email = v_owner, owner_email = null, pending_owner_email = null, pending_owner_is_group = false
    where suite_key = p_suite_key;
  else
    update suite_keys set owner_email = v_owner, owner_group_email = null, pending_owner_email = null, pending_owner_is_group = false
    where suite_key = p_suite_key;
  end if;
  if not found then raise exception 'suite key not found'; end if;

  insert into audit_log (action, suite_key, performed_by, ip_address)
  values ('sk_verified', p_suite_key, v_admin, current_client_ip());

  return query
    update subscriptions s
    set status = 'pending', pending_approver_email = null, pending_approver_is_group = false
    from licenses l
    where s.suite_key = p_suite_key and s.status = 'pending_sk_verification'
      and s.pending_approver_email = v_owner and l.id = s.license_id
    returning s.id, s.user_email, l.name, l.more_info_url;
end;
$$;

drop function if exists deny_sk_ownership(text);

create or replace function deny_sk_ownership(p_suite_key text)
returns table(id uuid, user_email text, license_name text)
language plpgsql security definer as $$
declare
  v_email text := require_profile_email();
  -- Same individual-first, then-group-membership resolution as
  -- confirm_sk_ownership() above — a group member declining a group's
  -- suggested-approver row can't match on their own email, only via
  -- group_memberships.
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

-- ─── RPC: get_my_suite_keys ─────────────────────────────────────────────────────
-- Exactly which Suite Keys the current user owns (individually or via a
-- Google Group). Needed instead of a plain `select suite_key from suite_keys`
-- because suite_keys' RLS policy returns *every* row to an admin — correct
-- for RLS's purposes, but wrong for "which keys are mine": an admin querying
-- suite_keys directly would see all of them and wrongly conclude they own
-- every Suite Key in the system. This is what src/lib/suiteKeyCharges.js
-- should call, not a raw select.

create or replace function get_my_suite_keys()
returns setof text language sql stable security definer as $$
  select suite_key from suite_keys where is_suite_key_owner(suite_key)
$$;

-- ─── RPC: search_suite_keys ─────────────────────────────────────────────────────
-- Typeahead for the Catalog request form, mirroring GAS's searchSuiteKeys().
-- suite_keys' own SELECT policy only returns keys you own (or all of them, if
-- you're an admin) — but anyone requesting a license needs to search *any*
-- Suite Key, including ones owned by someone else entirely, to avoid
-- accidentally creating a duplicate. Bypasses RLS for just this lookup, and
-- deliberately never returns owner_email/owner_group_email — only whether the
-- key already has an owner — so a regular requester can't harvest other
-- people's email addresses through the search box.

create or replace function search_suite_keys(p_query text)
returns table(suite_key text, description text, has_owner boolean)
language sql stable security definer as $$
  select suite_key, description, (owner_email is not null or owner_group_email is not null) as has_owner
  from suite_keys
  where suite_key ilike '%' || trim(p_query) || '%'
  order by suite_key
  limit 10
$$;

-- ─── RPC: get_suite_key_owner ──────────────────────────────────────────────────
-- Narrow, RLS-bypassing lookup for one specific thing: who to notify about a
-- given Suite Key. Needed because suite_keys' own SELECT policy only lets you
-- read rows you own (or as admin) — but e.g. after request_subscription()
-- puts a subscription into 'pending', the *requester* (who doesn't own the
-- key) needs to know who to email client-side. Returns both columns since a
-- key is owned by exactly one of the two (never both) — the caller checks
-- owner_group_email first, falling back to owner_email.

drop function if exists get_suite_key_owner(text);

create or replace function get_suite_key_owner(p_suite_key text)
returns table(owner_email text, owner_group_email text)
language sql stable security definer as $$
  select owner_email, owner_group_email from suite_keys where suite_key = p_suite_key;
$$;

-- ─── RPC: get_admin_emails ──────────────────────────────────────────────────────
-- Same narrow-RLS-bypass rationale as get_suite_key_owner above: when a
-- subscription lands in 'approved' (needs provisioning) and the license has
-- no service_manager_email set, the client needs a fallback list of who to
-- notify — but profiles' own SELECT policy only lets a caller read their own
-- row (or all rows, if they're already an admin). A brand-new requester is
-- neither, so this exists to answer just that one question.

create or replace function get_admin_emails()
returns setof text
language sql stable security definer as $$
  select primary_email from profiles where role = 'admin' and primary_email is not null;
$$;

-- ─── RPC: get_seat_provisioning_fields ─────────────────────────────────────────
-- Same narrow-RLS-bypass rationale as get_admin_emails above: the
-- "provisioning required" email needs the seat's user's display name/job
-- title/department (not just their email, which is all subscriptions.
-- user_email carries) so whoever provisions the seat manually has something
-- to type into the vendor portal — but profiles' own SELECT policy only lets
-- a caller read their own row (or all rows, if admin). One round trip for all
-- three fields instead of three near-identical single-field lookups.

create or replace function get_seat_provisioning_fields(p_email text)
returns table(display_name text, job_title text, department text)
language sql stable security definer as $$
  select display_name, job_title, department from profiles where lower(primary_email) = lower(p_email) limit 1;
$$;

-- ─── RPC: get_my_pending_sk_verifications / get_my_pending_approvals /
--          get_my_pending_provisioning ─────────────────────────────────────
-- The Action Center page's "here's what needs MY attention" lists. Deliberately
-- NOT is_admin()-inclusive, unlike subscriptions' own RLS policy — scoped to
-- exactly what the next click (confirm_sk_ownership, approve_subscription/
-- decline_subscription, activate_subscription) would actually authorize for
-- a non-admin, so an admin viewing their own Action Center page doesn't see
-- every pending row company-wide, only their own. Admins acting on someone
-- else's key have dedicated tools elsewhere (Admin -> SuiteKeys'
-- quick-confirm, sk-merge).
--
-- get_my_pending_provisioning() exists for non-admin service managers (e.g.
-- a vendor-side contact who provisions seats for one license, like
-- CrashPlan) — they can already reach Admin -> All Subscriptions to do the
-- provisioning itself (is_service_manager_for grants that there, see the
-- "subscriptions: read own or authority" RLS policy below), but had no way
-- to discover that a seat was waiting on them without visiting that page
-- speculatively.

create or replace function get_my_pending_sk_verifications()
returns table(id uuid, user_email text, suite_key text, license_name text)
language sql stable security definer as $$
  select s.id, s.user_email, s.suite_key, l.name
  from subscriptions s join licenses l on l.id = s.license_id
  where s.status = 'pending_sk_verification'
    and (
      s.pending_approver_email = current_profile_email()
      or (s.pending_approver_is_group and exists (
        select 1 from group_memberships gm
        where gm.group_email = s.pending_approver_email and lower(gm.member_email) = current_profile_email()
      ))
    )
  order by s.created_at
$$;

create or replace function get_my_pending_approvals()
returns table(id uuid, user_email text, suite_key text, license_name text)
language sql stable security definer as $$
  select s.id, s.user_email, s.suite_key, l.name
  from subscriptions s join licenses l on l.id = s.license_id
  where s.status = 'pending'
    and (is_suite_key_owner(s.suite_key) or s.pending_approver_email = current_profile_email())
  order by s.created_at
$$;

create or replace function get_my_pending_provisioning()
returns table(id uuid, user_email text, suite_key text, license_name text)
language sql stable security definer as $$
  select s.id, s.user_email, s.suite_key, l.name
  from subscriptions s join licenses l on l.id = s.license_id
  where s.status = 'approved'
    and is_service_manager_for(s.license_id)
  order by s.created_at
$$;

-- ─── RPC: admin_update_suite_key_owner ─────────────────────────────────────────
-- Mirrors Managers.gs updateSuiteKeyOwner(), extended for group ownership.
-- Admin-only, creates the Suite Key row if it doesn't exist yet. Exactly one
-- of p_new_owner_email / p_owner_group_email may be set (mutually exclusive);
-- passing both is an error, passing neither unassigns the key entirely.
--
-- Ownership takes effect immediately either way (admin assignment is
-- authoritative) — but what happens to subscriptions still awaiting
-- verification on this key differs:
--   - Individual owner: only pending_approver_email is re-pointed to them —
--     matches GAS, and they still need to actually confirm via
--     confirm_sk_ownership() (widened earlier to allow this) before the
--     request advances to 'pending'.
--   - Group owner: goes straight to 'pending' with no confirmation step at
--     all — being in the group already proves authorization, there's no
--     "suggested approver" to verify.
-- Either way, the affected subscriptions are returned so the caller can notify.

create or replace function admin_update_suite_key_owner(
  p_suite_key text, p_new_owner_email text, p_owner_group_email text default null
) returns table(id uuid, user_email text, license_name text)
language plpgsql security definer as $$
declare
  v_owner text := nullif(lower(trim(p_new_owner_email)), '');
  v_group text := nullif(lower(trim(p_owner_group_email)), '');
  v_canonical_key text;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  -- Anything from "~" onward is stray pasted text, not part of the real key
  -- (e.g. "Relations-U_SIL~5407") — ignore it rather than rejecting the
  -- whole entry, same as request_subscription().
  p_suite_key := regexp_replace(trim(p_suite_key), '~.*$', '');
  if p_suite_key = '' then raise exception 'suite key is required'; end if;
  if v_owner is not null and v_group is not null then
    raise exception 'a suite key can have an individual owner or a group owner, not both';
  end if;

  -- Normalize to any existing row's actual casing before the upsert below —
  -- otherwise typing a "new" SuiteKey that only differs by case from one
  -- that already exists (e.g. "relations-u_sil" vs "Relations-U_SIL")
  -- silently creates a second, duplicate row instead of updating the real one.
  select suite_key into v_canonical_key from suite_keys where lower(suite_key) = lower(p_suite_key);
  if v_canonical_key is not null then
    p_suite_key := v_canonical_key;
  end if;

  insert into suite_keys (suite_key, owner_email, owner_group_email)
  values (p_suite_key, v_owner, v_group)
  on conflict (suite_key) do update
    -- An explicit admin-assigned owner supersedes any still-outstanding
    -- key-level pending claim (see admin_update_subscription_suite_key()) —
    -- left untouched when unassigning (both v_owner/v_group null), since
    -- that doesn't actually resolve anything. description is deliberately
    -- untouched here — it's exclusively driven by the daily
    -- suite_keys_current sync (reconcile_suite_keys_from_current()), not
    -- admin-settable at all.
    set owner_email = v_owner,
        owner_group_email = v_group,
        pending_owner_email = case when v_owner is not null or v_group is not null then null else suite_keys.pending_owner_email end,
        pending_owner_is_group = case when v_owner is not null or v_group is not null then false else suite_keys.pending_owner_is_group end;

  if v_group is not null then
    return query
      update subscriptions s
      set status = 'pending', pending_approver_email = null
      from licenses l
      where s.suite_key = p_suite_key and s.status = 'pending_sk_verification' and l.id = s.license_id
      returning s.id, s.user_email, l.name;
  elsif v_owner is not null then
    return query
      update subscriptions s
      set pending_approver_email = v_owner
      from licenses l
      where s.suite_key = p_suite_key and s.status = 'pending_sk_verification' and l.id = s.license_id
      returning s.id, s.user_email, l.name;
  end if;
end;
$$;

-- ─── RPC: admin_update_subscription_suite_key ──────────────────────────────────
-- Lets an admin repoint an existing subscription onto a different SuiteKey
-- from Admin -> All Subscriptions' details modal — e.g. it was billed
-- against the wrong key, or the underlying budget moved to a new one.
-- Deliberately never touches the subscription's status or activated_at — an
-- admin fixing which key pays for an already-active subscription isn't the
-- same as re-requesting/re-approving it, and nothing about its provisioning
-- state should reset. It still emails the new key's owner (or, if unclaimed,
-- a suggested approver the caller supplies, client-side classified as an
-- individual or Google Group same as request_subscription()) so they're
-- aware a request now sits against their key — the subscription itself
-- never waits on their response.
--
-- An unclaimed new key's pending claim can't live on this subscription's own
-- pending_approver_email/status = 'pending_sk_verification' the way
-- request_subscription() tracks it, since (again) this subscription's status
-- must not change — it lives on suite_keys.pending_owner_email/
-- pending_owner_is_group instead. admin_confirm_sk_ownership()/
-- admin_update_suite_key_owner() above already know to resolve and clear it.

create or replace function admin_update_subscription_suite_key(
  p_subscription_id uuid,
  p_suite_key text,
  p_suggested_approver_email text default null,
  p_suggested_approver_is_group boolean default false
) returns table(suite_key text, owner_email text, owner_group_email text, pending_verification boolean)
language plpgsql security definer as $$
declare
  v_admin text := current_profile_email();
  v_old_key text;
  v_billing_type subscription_billing_type;
  v_new_key text;
  v_canonical text;
  v_owner text;
  v_owner_group text;
  v_suggested text := nullif(lower(trim(p_suggested_approver_email)), '');
begin
  if not is_admin() then raise exception 'admin only'; end if;

  select s.suite_key, s.billing_type into v_old_key, v_billing_type
  from subscriptions s where s.id = p_subscription_id;
  if not found then raise exception 'subscription not found'; end if;
  if v_billing_type <> 'suite_key' then raise exception 'this subscription is not billed by SuiteKey'; end if;

  -- Anything from "~" onward is stray pasted text, not part of the real key —
  -- same normalization as request_subscription().
  v_new_key := regexp_replace(trim(p_suite_key), '~.*$', '');
  if v_new_key = '' then raise exception 'a suite key is required'; end if;
  if lower(v_new_key) = lower(coalesce(v_old_key, '')) then
    raise exception 'subscription already uses this suite key';
  end if;

  select sk.suite_key, sk.owner_email, sk.owner_group_email into v_canonical, v_owner, v_owner_group
  from suite_keys sk where lower(sk.suite_key) = lower(v_new_key);

  if v_canonical is not null then
    v_new_key := v_canonical;
  else
    insert into suite_keys (suite_key, owner_email) values (v_new_key, null);
  end if;

  if v_owner is null and v_owner_group is null and v_suggested is null then
    raise exception 'suite key % has no owner on file — provide a suggested approver email', v_new_key;
  end if;

  update subscriptions set suite_key = v_new_key where id = p_subscription_id;

  if v_owner is not null or v_owner_group is not null then
    insert into audit_log (action, subscription_id, suite_key, performed_by, notes, ip_address)
    values (
      'suite_key_updated', p_subscription_id, v_new_key, v_admin,
      'changed from ' || coalesce(v_old_key, '(none)') || ' to ' || v_new_key, current_client_ip()
    );
    return query select v_new_key, v_owner, v_owner_group, false;
    return;
  end if;

  update suite_keys
  set pending_owner_email = v_suggested, pending_owner_is_group = coalesce(p_suggested_approver_is_group, false)
  where suite_keys.suite_key = v_new_key;

  insert into audit_log (action, subscription_id, suite_key, performed_by, notes, ip_address)
  values (
    'suite_key_updated', p_subscription_id, v_new_key, v_admin,
    'changed from ' || coalesce(v_old_key, '(none)') || ' to ' || v_new_key ||
      '; awaiting ownership confirmation from ' || v_suggested,
    current_client_ip()
  );

  return query select v_new_key, null::text, null::text, true;
end;
$$;

-- ─── RPC: admin_merge_suite_key ────────────────────────────────────────────────
-- For data-entry typos, e.g. someone fat-fingers "Relatoins-U_SIL" instead of
-- the real "Relations-U_SIL" — not a case/whitespace variant the earlier
-- fixes catch, nor tilde-appended garbage (now stripped automatically at
-- entry — see request_subscription()), so it creates a real, separate,
-- unowned key. There was previously no way to delete it: subscriptions.
-- suite_key's FK blocks a plain delete while any subscription still points
-- at it. This repoints those subscriptions to the correct key first, then
-- deletes the bad row.
--
-- Refuses to merge away a key that has a real owner on file — that's very
-- unlikely to be a typo, and merging would silently destroy real ownership
-- data. If that guard is ever wrong, unassign the owner first (admin_update_
-- suite_key_owner with a blank owner), then merge.

create or replace function admin_merge_suite_key(p_bad_key text, p_correct_key text)
returns void language plpgsql security definer as $$
declare
  v_bad text := trim(p_bad_key);
  v_correct text;
  v_owner text;
  v_owner_group text;
  r record;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  if v_bad = '' or p_correct_key is null or trim(p_correct_key) = '' then
    raise exception 'both the bad and correct suite keys are required';
  end if;

  select suite_key, owner_email, owner_group_email into v_correct, v_owner, v_owner_group
  from suite_keys where lower(suite_key) = lower(trim(p_correct_key));
  if v_correct is null then raise exception 'suite key % does not exist', p_correct_key; end if;

  if lower(v_bad) = lower(v_correct) then
    raise exception 'bad and correct suite keys must be different';
  end if;

  if exists (
    select 1 from suite_keys where suite_key = v_bad and (owner_email is not null or owner_group_email is not null)
  ) then
    raise exception 'suite key % has an owner on file — this looks like a real key, not a typo', v_bad;
  end if;

  update subscriptions set suite_key = v_correct where suite_key = v_bad;

  -- Repointing alone isn't enough: any of those subscriptions sitting in
  -- pending_sk_verification were waiting on someone to confirm the (bad,
  -- unowned) key's ownership. Now that they're on the correct key, ownership
  -- may already be established — re-run the same owner/group decision
  -- request_subscription() would have made if it had matched the right key
  -- to begin with, instead of leaving them stuck awaiting a confirmation
  -- that's no longer needed.
  for r in
    select s.id, s.user_email
    from subscriptions s
    where s.suite_key = v_correct and s.status = 'pending_sk_verification'
  loop
    if v_owner_group is not null then
      if exists (select 1 from group_memberships where group_email = v_owner_group and member_email = r.user_email) then
        update subscriptions set status = 'approved', pending_approver_email = null where id = r.id;
      else
        update subscriptions set status = 'pending', pending_approver_email = null where id = r.id;
      end if;
    elsif v_owner is not null then
      if v_owner = r.user_email then
        update subscriptions set status = 'approved', pending_approver_email = null where id = r.id;
      else
        update subscriptions set status = 'pending', pending_approver_email = null where id = r.id;
      end if;
    end if;
    -- else: the correct key is itself still unowned — leave it in
    -- pending_sk_verification, genuinely still awaiting a suggested approver.
  end loop;

  insert into audit_log (action, suite_key, performed_by, notes, ip_address)
  values ('sk_merged', v_correct, current_profile_email(), 'merged from "' || v_bad || '"', current_client_ip());

  delete from suite_keys where suite_key = v_bad;
end;
$$;

-- ─── RPC: approve_subscription / decline_subscription ─────────────────────────

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

  -- Owner approval only clears the SuiteKey-ownership (or, for
  -- department-gated licenses, department-approver) gate — it never skips
  -- provisioning. No license is auto-provisioned today, so this always lands
  -- on 'approved' and relies on buildProvisioningNotifications() (see
  -- src/lib/subscriptions.js) firing off the "someone needs to provision
  -- this" email, same as request_subscription()'s auto-approved paths.
  update subscriptions set status = 'approved' where id = p_subscription_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, ip_address)
  values ('approved', p_subscription_id, v_license.name, v_sub.user_email, v_sub.suite_key, v_email, current_client_ip());
end;
$$;

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

-- ─── RPC: activate_subscription / cancel_subscription / revoke_subscription ──

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
  -- supabase/functions/sync-provisioning/adapters/google-group.ts. No
  -- special note needed here, same as every other automated adapter.
  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, ip_address)
  values ('activated', p_subscription_id, v_license.name, v_sub.user_email, v_sub.suite_key, v_email, current_client_ip());
end;
$$;

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
-- renewal_price is the license's *current* full annual price (l.price),
-- not the subscription's price_at_signup — a renewal always bills at full
-- price, and that snapshot can be pro-rated or hand-corrected to a one-time
-- invoice amount. Column deliberately renamed from the original
-- price_at_signup so it can't be confused with the signup snapshot again —
-- see pending/68_start_renewal_period_full_price.sql.
create or replace function start_renewal_period(p_license_id uuid, p_fiscal_year int)
returns table(
  subscription_id uuid, user_email text, license_name text, billing_label text,
  renewal_price numeric, renewal_month int, reminder_message text
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
      s.renewal_month, s.license_id
  ), logged as (
    insert into renewals (subscription_id, fiscal_year, reminder_sent_at, decision)
    select o.id, p_fiscal_year, now(), 'none' from opened o
    -- Table-qualified: this function's RETURNS TABLE declares an OUT
    -- parameter also named subscription_id, which plpgsql exposes as an
    -- ordinary variable in scope here — an unqualified `returning
    -- subscription_id` is ambiguous between that variable and
    -- renewals.subscription_id (raises "column reference is ambiguous").
    returning renewals.subscription_id
  )
  select
    o.id, o.user_email, l.name,
    case
      when o.billing_type = 'gtis' then 'GTIS'
      when o.billing_type = 'ministry' then 'Ministry ID ' || o.ministry_id
      when o.billing_type = 'free' then 'Free'
      else o.suite_key
    end,
    l.price, o.renewal_month, l.reminder_message
  from opened o
  join licenses l on l.id = o.license_id;
end;
$$;

-- ─── Trigger: flag_renewal_on_suite_key_change ─────────────────────────────────
-- When a subscription's SuiteKey changes (admin repoint via
-- admin_update_subscription_suite_key(), or any future user-facing flow), the
-- new key's owner never agreed to pay for it. Flags the subscription so its
-- next renewal opt-in is routed to the new key's owner for approval instead
-- of applying straight away. Not set when the old key had no owner (the
-- admin_merge_suite_key() typo-fix case, which only ever merges away unowned
-- keys).
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

-- ─── RPC: opt_in_renewal / opt_out_renewal ─────────────────────────────────────
-- Both resolve against open_renewal_fy: a decision can only be made while a
-- period is actually open (started via start_renewal_period), never ad-hoc.

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

  -- SuiteKey changed since the owner last signed off: park the renewal for
  -- the current key's owner instead of applying it. (If the caller IS that
  -- owner, there's nobody else to ask.)
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

-- ─── RPC: approve_renewal / decline_renewal ────────────────────────────────────
-- Completes or rejects a renewal parked by opt_in_renewal() because the
-- SuiteKey changed. Decline behaves like an opt-out.
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

-- ─── RPC: get_my_pending_renewal_approvals ─────────────────────────────────────
-- Same scoping rule as get_my_pending_approvals(): not admin-inclusive, only
-- what the caller can personally act on. Feeds the Action Center.
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

-- ─── RPC: update_subscription_details ──────────────────────────────────────────
-- Notes, product key, invoice number, and price paid — a small "purchase
-- details" set edited together from one modal in Admin -> All Subscriptions
-- (notes/product_key/invoice_number distinct from licenses.notes, which is a
-- catalog-level note about the license itself, not any one subscription).
-- Same authority as cancel_subscription()'s admin-or-service-manager check,
-- minus the self-service branch: these are internal annotations for whoever
-- administers the license, not something the subscriber sets on their own
-- request. p_price_paid directly overwrites price_at_signup (unlike
-- activate_subscription()'s p_price, which only fills it in if not already
-- set) — this is an explicit edit action, not a "don't clobber what's
-- already there" one.

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

-- ─── RPC: admin_update_ministry_id ──────────────────────────────────────────────
-- Mirrors Managers.gs updateMinistryId(): admin-only, upserts a 6-digit
-- Ministry ID for an email, or deletes the row if p_ministry_id is blank.

create or replace function admin_update_ministry_id(p_email text, p_ministry_id text)
returns void language plpgsql security definer as $$
declare
  v_email text := lower(trim(p_email));
  v_id text := nullif(trim(p_ministry_id), '');
begin
  if not is_admin() then raise exception 'admin only'; end if;
  if v_email = '' then raise exception 'email is required'; end if;

  if v_id is null then
    delete from ministry_ids where email = v_email;
    return;
  end if;

  if v_id !~ '^\d{6}$' then raise exception 'ministry ID must be exactly 6 digits'; end if;

  insert into ministry_ids (email, ministry_id) values (v_email, v_id)
  on conflict (email) do update set ministry_id = excluded.ministry_id;
end;
$$;

-- ─── RPC: admin_import_team_hierarchy / get_last_team_import ────────────────
-- Admin CSV importer for profiles.manager_email/sco/job_title, fed by a
-- weekly export of the Workday-derived org-hierarchy Sheet (see README's My
-- Team section) — there's no live API pull, since a direct Workday
-- integration isn't currently available and Workday itself is being retired
-- within a year. Mirrors admin_import_subscriptions()'s shape: one result
-- per input row, a bad row never aborts the batch.
--
-- Unlike admin_import_subscriptions()'s placeholder-profile path (which has
-- no eligibility gate — it's one historical requester at a time, already a
-- known SIL person), a missing profile here is only created after passing
-- is_eligible_staff_email() — the hierarchy export can include people this
-- app should never have a row for (external contractors/vendors, terminated
-- staff still on an old export, a shared/generic mailbox listed as someone's
-- manager); rows that fail eligibility are reported back as failures, not
-- silently skipped.
--
-- get_last_team_import() is a narrow security-definer read so the My Team
-- page can show "last imported on X" without granting non-admins direct
-- select on team_hierarchy_imports — same rationale as get_report_emails/
-- get_admin_emails elsewhere in this file.

create or replace function admin_import_team_hierarchy(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_admin text := current_profile_email();
  v_row jsonb;
  v_results jsonb[] := '{}';
  v_email text;
  v_manager_email text;
  v_sco text;
  v_job_title text;
  v_employee_type text;
  v_staff_id text;
  v_ok_count int := 0;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_email := lower(trim(v_row->>'primary_email'));
      v_manager_email := nullif(trim(lower(v_row->>'manager_email')), '');
      v_sco := nullif(trim(upper(v_row->>'sco')), '');
      v_job_title := nullif(trim(v_row->>'job_title'), '');
      v_employee_type := nullif(trim(v_row->>'employee_type'), '');
      v_staff_id := nullif(trim(v_row->>'staff_id'), '');

      if v_email = '' or v_email is null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', 'Missing primary_email', 'row', v_row);
        continue;
      end if;

      if v_sco is not null and v_sco !~ '^[A-Z]{3}$' then
        v_results := v_results || jsonb_build_object('ok', false, 'error', 'SCO must be exactly 3 letters: ' || v_sco, 'row', v_row);
        continue;
      end if;

      if not exists (select 1 from profiles where lower(primary_email) = v_email) then
        if not is_eligible_staff_email(v_email) then
          v_results := v_results || jsonb_build_object('ok', false, 'error', 'Not an eligible staff email: ' || v_email, 'row', v_row);
          continue;
        end if;
        insert into profiles (display_name, primary_email) values (v_email, v_email);
      end if;

      update profiles set manager_email = v_manager_email, sco = v_sco, job_title = v_job_title,
        employee_type = v_employee_type, staff_id = v_staff_id
        where lower(primary_email) = v_email;

      v_ok_count := v_ok_count + 1;
      v_results := v_results || jsonb_build_object('ok', true, 'row', v_row);
    exception when others then
      v_results := v_results || jsonb_build_object('ok', false, 'error', sqlerrm, 'row', v_row);
    end;
  end loop;

  insert into team_hierarchy_imports (performed_by, row_count) values (v_admin, v_ok_count);

  return to_jsonb(v_results);
end;
$$;

create or replace function get_last_team_import()
returns table(created_at timestamptz, row_count int)
language sql stable security definer as $$
  select created_at, row_count from team_hierarchy_imports order by created_at desc limit 1
$$;

-- ─── RPC: save_license / deactivate_license (admin catalog CRUD) ─────────────

-- Full reconciled param list (service_manager_emails array, provisioning
-- adapter/config + email-field flags, department_gated, requires_
-- acknowledgement/acknowledgement_text, extra field, allow_multiple_per_person,
-- receiving_suite_key) — this function's body is always
-- rewritten from scratch, never diffed, so each new admin-editable column
-- lands here alongside every earlier one instead of drifting out of sync.
create or replace function save_license(p_license jsonb)
returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
  v_service_manager_emails text[];
begin
  if not is_admin() then raise exception 'admin only'; end if;

  select coalesce(array_agg(trim(e)), '{}'::text[]) into v_service_manager_emails
  from jsonb_array_elements_text(coalesce(p_license->'service_manager_emails', '[]'::jsonb)) e
  where trim(e) <> '';

  v_id := (p_license->>'id')::uuid;
  if v_id is null then
    insert into licenses (
      name, vendor, category, price, price_unit, notes, gtis_sponsored,
      billing_cycle, renewal_month, renewal_reminder, logo_url, activation_url,
      more_info_url, google_group_email, pro_rated, service_manager_emails,
      onboarding_message, reminder_message, provisioning_adapter, provisioning_config,
      provisioning_email_show_name, provisioning_email_show_job_title, provisioning_email_show_department,
      department_gated, requires_acknowledgement, acknowledgement_text,
      extra_field_label, extra_field_required, allow_multiple_per_person, receiving_suite_key, created_by
    ) values (
      p_license->>'name', p_license->>'vendor', p_license->>'category',
      (p_license->>'price')::numeric, p_license->>'price_unit', p_license->>'notes',
      coalesce((p_license->>'gtis_sponsored')::boolean, false),
      coalesce((p_license->>'billing_cycle')::billing_cycle, 'annual'),
      (p_license->>'renewal_month')::int,
      coalesce((p_license->>'renewal_reminder')::boolean, true),
      p_license->>'logo_url', p_license->>'activation_url', p_license->>'more_info_url',
      p_license->>'google_group_email', coalesce((p_license->>'pro_rated')::boolean, false),
      v_service_manager_emails,
      nullif(p_license->>'onboarding_message', ''), nullif(p_license->>'reminder_message', ''),
      nullif(p_license->>'provisioning_adapter', ''), nullif(p_license->>'provisioning_config', '')::jsonb,
      coalesce((p_license->>'provisioning_email_show_name')::boolean, false),
      coalesce((p_license->>'provisioning_email_show_job_title')::boolean, false),
      coalesce((p_license->>'provisioning_email_show_department')::boolean, false),
      coalesce((p_license->>'department_gated')::boolean, false),
      coalesce((p_license->>'requires_acknowledgement')::boolean, false),
      nullif(p_license->>'acknowledgement_text', ''),
      nullif(p_license->>'extra_field_label', ''),
      coalesce((p_license->>'extra_field_required')::boolean, false),
      coalesce((p_license->>'allow_multiple_per_person')::boolean, false),
      coalesce(nullif(trim(p_license->>'receiving_suite_key'), ''), 'WaxhawIT-U_SIL'),
      current_profile_id()
    ) returning id into v_id;
  else
    update licenses set
      name = p_license->>'name', vendor = p_license->>'vendor', category = p_license->>'category',
      price = (p_license->>'price')::numeric, price_unit = p_license->>'price_unit', notes = p_license->>'notes',
      gtis_sponsored = coalesce((p_license->>'gtis_sponsored')::boolean, false),
      billing_cycle = coalesce((p_license->>'billing_cycle')::billing_cycle, 'annual'),
      renewal_month = (p_license->>'renewal_month')::int,
      renewal_reminder = coalesce((p_license->>'renewal_reminder')::boolean, true),
      logo_url = p_license->>'logo_url', activation_url = p_license->>'activation_url',
      more_info_url = p_license->>'more_info_url', google_group_email = p_license->>'google_group_email',
      pro_rated = coalesce((p_license->>'pro_rated')::boolean, false),
      service_manager_emails = v_service_manager_emails,
      onboarding_message = nullif(p_license->>'onboarding_message', ''),
      reminder_message = nullif(p_license->>'reminder_message', ''),
      provisioning_adapter = nullif(p_license->>'provisioning_adapter', ''),
      provisioning_config = nullif(p_license->>'provisioning_config', '')::jsonb,
      provisioning_email_show_name = coalesce((p_license->>'provisioning_email_show_name')::boolean, false),
      provisioning_email_show_job_title = coalesce((p_license->>'provisioning_email_show_job_title')::boolean, false),
      provisioning_email_show_department = coalesce((p_license->>'provisioning_email_show_department')::boolean, false),
      department_gated = coalesce((p_license->>'department_gated')::boolean, false),
      requires_acknowledgement = coalesce((p_license->>'requires_acknowledgement')::boolean, false),
      acknowledgement_text = nullif(p_license->>'acknowledgement_text', ''),
      extra_field_label = nullif(p_license->>'extra_field_label', ''),
      extra_field_required = coalesce((p_license->>'extra_field_required')::boolean, false),
      allow_multiple_per_person = coalesce((p_license->>'allow_multiple_per_person')::boolean, false),
      receiving_suite_key = coalesce(nullif(trim(p_license->>'receiving_suite_key'), ''), 'WaxhawIT-U_SIL')
    where id = v_id;
  end if;

  return v_id;
end;
$$;

-- ─── RPC: admin CRUD for department_approvals ────────────────────────────────
-- Table RLS is already admin-only, so these are thin wrappers for the admin
-- UI rather than a security boundary of their own — same rationale as
-- save_license()/deactivate_license() being security-definer + an explicit
-- is_admin() check even though RLS would block a non-admin anyway.

create or replace function admin_list_department_approvals(p_license_id uuid)
returns table(id uuid, sco text, approver_email text)
language sql stable security definer as $$
  select id, sco, approver_email from department_approvals
  where license_id = p_license_id order by sco
$$;

create or replace function admin_add_department_approval(p_license_id uuid, p_sco text, p_approver_email text)
returns uuid language plpgsql security definer as $$
declare v_id uuid;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  insert into department_approvals (license_id, sco, approver_email)
  values (p_license_id, upper(trim(p_sco)), lower(trim(p_approver_email)))
  on conflict (license_id, sco) do update set approver_email = excluded.approver_email
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function admin_remove_department_approval(p_id uuid)
returns void language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  delete from department_approvals where id = p_id;
end;
$$;

create or replace function deactivate_license(p_license_id uuid)
returns void language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  update licenses set active = false where id = p_license_id;
end;
$$;

-- save_license()'s UPDATE branch deliberately never touches `active` — it's
-- a distinct action with its own confirmation, not a field you'd casually
-- leave toggled while editing everything else. This is the reactivate side
-- deactivate_license() was missing entirely.
create or replace function reactivate_license(p_license_id uuid)
returns void language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  update licenses set active = true where id = p_license_id;
end;
$$;

-- ─── RPC: calc_prorated_cost / get_finance_export ──────────────────────────────
-- Ported from gas-legacy/src/Catalog.gs's _calcProRatedCost()/getFinanceExport().
-- Pro-rating only applies when licenses.pro_rated is set — everything else
-- charges the flat license price regardless of when in the cycle it started.
--   - Monthly: day-based — days remaining in the start month (inclusive of
--     the start day) as a fraction of days in that month.
--   - Annual (default): month-based — months remaining from the start date
--     to the next occurrence of the license's renewal_month (1-12), defaulting
--     to October (SIL's FY start) if unset.
-- Not security definer — relies on the caller's own RLS read access (admins
-- can already read every subscriptions/licenses row via existing policies;
-- this just adds the math on top).

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

-- 'active' subscriptions ignore the date range entirely: start_date is the
-- original request date and never changes on renewal (opt_in_renewal() only
-- logs to renewals/flips renewal_status), so filtering active rows by range
-- would silently drop anything still billable that started outside it.
-- 'approved' rows (not yet activated) still need the range filter, or every
-- never-activated approval ever made would show up in every export forever.
-- renewed_date surfaces the most recent fiscal-year renewal opt-in
-- (renewals.opt_in_date) so finance can tell a long-running active
-- subscription apart from one still on its original term — null means it
-- hasn't been through opt_in_renewal() yet.
-- price_paid is subscriptions.price_at_signup — the license price snapshotted
-- at request/activation time — kept separate from `cost` because `cost`
-- recalculates off the license's *current* price, which drifts from what was
-- actually charged once a license's price changes after the fact.
-- product_key/invoice_number/notes surface the rest of subscriptions'
-- purchase-details set (all edited together via update_subscription_details())
-- so finance can see this context without cross-referencing Admin -> All
-- Subscriptions — distinct from licenses.notes, which is about the catalog
-- item, not any one subscription.
-- receiving_suite_key (the license's receiving suite key) sits right after
-- billing_label. Adds new OUT columns, so Postgres won't let create-or-replace alter the
-- existing return type in place — drop it first.
drop function if exists get_finance_export(date, date);

create function get_finance_export(p_start_date date, p_end_date date)
returns table(
  user_email text, license_name text, billing_label text, receiving_suite_key text, cost numeric, price_paid numeric,
  product_key text, invoice_number text, start_date date, renewed_date date, status text, notes text
) language sql stable as $$
  select
    s.user_email,
    l.name,
    case
      when s.billing_type = 'gtis' then 'GTIS'
      when s.billing_type = 'ministry' then 'Ministry ID ' || s.ministry_id
      when s.billing_type = 'free' then 'Free'
      else s.suite_key
    end,
    l.receiving_suite_key,
    calc_prorated_cost(l.price, l.billing_cycle, l.renewal_month, l.pro_rated, s.start_date),
    s.price_at_signup,
    s.product_key,
    s.invoice_number,
    s.start_date,
    (select max(r.opt_in_date) from renewals r where r.subscription_id = s.id),
    s.status::text,
    -- Folds in extra_field_value (e.g. a Shared Drive's name) so it isn't
    -- lost from the export when an admin never separately typed it into
    -- notes — extra_field_value is set once at request time and often left
    -- as the only record of it (see licenses.extra_field_label).
    concat_ws(
      '; ',
      s.notes,
      case when s.extra_field_value is not null
        then coalesce(l.extra_field_label, 'Extra field') || ': ' || s.extra_field_value
      end
    )
  from subscriptions s
  join licenses l on l.id = s.license_id
  where s.status = 'active'
     or (s.status = 'approved' and s.start_date >= p_start_date and s.start_date <= p_end_date)
  order by s.start_date;
$$;

-- ─── RPC: admin_import_subscriptions ────────────────────────────────────────────
-- Ported from gas-legacy/src/Catalog.gs's importSubscriptions(). Bulk-creates
-- already-active subscriptions from a legacy/historical source — no approval
-- emails, no SK verification step, no Google Group changes. Skips rows where
-- the user already has a non-cancelled/declined/revoked subscription for the
-- same license+FY (mirrors request_subscription()'s own duplicate check).
--
-- p_rows is a JSON array of {user_email, license_name, suite_key, start_date,
-- fy, requester_email}: suite_key accepts a real SuiteKey, a 6-digit
-- Ministry ID (bare or "MIN:XXXXXX"), or blank for a GTIS-sponsored license.
-- Applies the same SuiteKey trim/tilde-strip/case-insensitive-match rules as
-- request_subscription(), for the same reasons — and the same FY rollover
-- rule as GAS's getCurrentFiscalYear() when fy isn't given (October start).
--
-- requester_email is optional: recorded as the subscription's requested_by
-- instead of defaulting to the importing admin — for historical rows where
-- someone else actually submitted the original request. Blank/omitted keeps
-- the old behavior. If it doesn't match an existing profile, a placeholder
-- one is created (display_name = the email itself) so requested_by can
-- still point at a real profiles row — resolve_profile() (schema.sql) links
-- that placeholder to their real Google account on their actual first
-- sign-in instead of erroring on the now-duplicate primary_email.
--
-- Each row is processed in its own sub-block so one bad row can't abort the
-- whole batch — returns one result object per input row: {ok, error?, row}.
-- NOT ported: GAS's ALLOWED_DOMAINS allowlist (a specific list of SIL-
-- affiliated external domains) — add it back here if bulk imports need it.

create or replace function admin_import_subscriptions(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_admin text := current_profile_email();
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_user_email text;
  v_license_name text;
  v_raw_suite_key text;
  v_start_date date;
  v_fy int;
  v_license licenses%rowtype;
  v_billing_type subscription_billing_type;
  v_suite_key text;
  v_ministry_id text;
  v_canonical_key text;
  v_requester_email text;
  v_requested_by uuid;
  v_sub_id uuid;
  v_error text;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_error := null;
      v_user_email := lower(trim(v_row->>'user_email'));
      v_license_name := trim(v_row->>'license_name');
      -- Anything from "~" onward is stray pasted text, not part of the real
      -- key (e.g. "Relations-U_SIL~5407") — ignore it rather than rejecting
      -- the row, same as admin_import_subscriptions_full() already does.
      v_raw_suite_key := regexp_replace(trim(coalesce(v_row->>'suite_key', '')), '~.*$', '');
      v_billing_type := null;
      v_suite_key := null;
      v_ministry_id := null;
      v_license := null;
      v_requested_by := current_profile_id();

      if v_user_email = '' or v_user_email is null then
        v_error := 'Missing email';
      elsif v_user_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
        v_error := 'Invalid email';
      elsif v_license_name = '' or v_license_name is null then
        v_error := 'Missing license name';
      end if;

      v_requester_email := nullif(trim(lower(v_row->>'requester_email')), '');
      if v_error is null and v_requester_email is not null then
        select id into v_requested_by from profiles where lower(primary_email) = v_requester_email;
        if v_requested_by is null then
          insert into profiles (display_name, primary_email) values (v_requester_email, v_requester_email)
            returning id into v_requested_by;
        end if;
      end if;

      if v_error is null then
        select * into v_license from licenses where lower(name) = lower(v_license_name) and active;
        if v_license.id is null then
          v_error := 'License not found in catalog: ' || v_license_name;
        end if;
      end if;

      if v_error is null then
        v_start_date := nullif(v_row->>'start_date', '')::date;
        if v_start_date is null then v_start_date := current_date; end if;

        if v_row->>'fy' is not null and (v_row->>'fy') != '' then
          v_fy := (v_row->>'fy')::int;
        else
          v_fy := extract(year from v_start_date)::int + (case when extract(month from v_start_date) >= 10 then 1 else 0 end);
        end if;

        if v_license.gtis_sponsored and v_raw_suite_key = '' then
          v_billing_type := 'gtis';
        elsif v_raw_suite_key ~ '^\d{6}$' or v_raw_suite_key ~* '^MIN:\d{6}$' then
          v_ministry_id := regexp_replace(v_raw_suite_key, '^MIN:', '', 'i');
          v_billing_type := 'ministry';
        elsif v_raw_suite_key = '' then
          v_error := 'Missing SuiteKey or Ministry ID';
        else
          v_billing_type := 'suite_key';
          select suite_key into v_canonical_key from suite_keys where lower(suite_key) = lower(v_raw_suite_key);
          v_suite_key := coalesce(v_canonical_key, v_raw_suite_key);
          if v_canonical_key is null then
            insert into suite_keys (suite_key, owner_email) values (v_suite_key, null);
          end if;
        end if;
      end if;

      if v_error is null and exists (
        select 1 from subscriptions
        where user_email = v_user_email and license_id = v_license.id and fy = v_fy
          and status not in ('declined', 'revoked', 'cancelled')
      ) then
        v_error := 'Already has a subscription for FY' || v_fy;
      end if;

      if v_error is not null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', v_error, 'row', v_row);
        continue;
      end if;

      insert into subscriptions (
        user_email, license_id, suite_key, billing_type, ministry_id, fy, status, start_date, activated_at,
        billing_cycle, renewal_month, renewal_reminder, price_at_signup, requested_by
      ) values (
        v_user_email, v_license.id, v_suite_key, v_billing_type, v_ministry_id, v_fy, 'active', v_start_date, v_start_date,
        v_license.billing_cycle, v_license.renewal_month, v_license.renewal_reminder, v_license.price, v_requested_by
      ) returning id into v_sub_id;

      if v_ministry_id is not null then
        insert into ministry_ids (email, ministry_id) values (v_user_email, v_ministry_id)
          on conflict (email) do update set ministry_id = excluded.ministry_id;
      end if;

      insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
      values (
        'imported', v_sub_id, v_license.name, v_user_email,
        case when v_billing_type = 'gtis' then 'GTIS' when v_billing_type = 'ministry' then 'MIN:' || v_ministry_id else v_suite_key end,
        v_admin, 'imported from legacy system', current_client_ip()
      );

      v_results := v_results || jsonb_build_object('ok', true, 'id', v_sub_id, 'row', v_row);
    exception when others then
      v_results := v_results || jsonb_build_object('ok', false, 'error', sqlerrm, 'row', v_row);
    end;
  end loop;

  return v_results;
end;
$$;

-- ─── RPC: admin_import_licenses ─────────────────────────────────────────────────
-- GAS's Licenses sheet, column-mapped 1:1 onto the new schema, with two
-- deliberate exceptions: (1) `activated` (GAS column 15) is dropped — it's
-- dead data, never read anywhere in gas-legacy/ beyond being persisted, and
-- has no equivalent column here; (2) `price_unit` is recomputed from
-- billing_cycle rather than copied from GAS's stored value, since GAS's own
-- data has price_unit stuck at "per seat/year" even for monthly-billed
-- licenses (the exact stale-text bug Admin -> Catalog's billing-cycle-driven
-- price unit was built to prevent — see Catalog.jsx's PRICE_UNITS map).

create or replace function admin_import_licenses(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_legacy_id text;
  v_name text;
  v_billing_cycle billing_cycle;
  v_created_by uuid;
  v_id uuid;
  v_error text;
  v_service_manager_email text;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_error := null;
      v_legacy_id := nullif(trim(v_row->>'legacy_id'), '');
      v_name := trim(v_row->>'name');

      if v_name = '' or v_name is null then
        v_error := 'Missing name';
      elsif exists (
        select 1 from licenses
        where (v_legacy_id is not null and legacy_id = v_legacy_id) or lower(name) = lower(v_name)
      ) then
        v_error := 'Already exists: ' || v_name;
      end if;

      if v_error is not null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', v_error, 'row', v_row);
        continue;
      end if;

      v_billing_cycle := coalesce(nullif(v_row->>'billing_cycle', ''), 'annual')::billing_cycle;

      v_created_by := null;
      if nullif(trim(v_row->>'created_by_email'), '') is not null then
        select id into v_created_by from profiles where lower(primary_email) = lower(trim(v_row->>'created_by_email'));
      end if;

      -- GAS's Licenses sheet only ever had one service-manager address, so a
      -- single-element array (or empty) is the correct mapping here — no
      -- delimiter splitting needed, unlike a hypothetical multi-value CSV source.
      v_service_manager_email := nullif(trim(lower(v_row->>'service_manager_email')), '');

      insert into licenses (
        legacy_id, name, vendor, category, price, price_unit, notes, active, gtis_sponsored,
        billing_cycle, renewal_month, renewal_reminder, created_by, logo_url, activation_url,
        more_info_url, google_group_email, pro_rated, service_manager_emails
      ) values (
        v_legacy_id, v_name, nullif(trim(v_row->>'vendor'), ''), nullif(trim(v_row->>'category'), ''),
        nullif(v_row->>'price', '')::numeric,
        case v_billing_cycle when 'annual' then 'per year' when 'monthly' then 'per month' else 'one-time' end,
        nullif(v_row->>'notes', ''),
        coalesce((v_row->>'active')::boolean, true),
        coalesce((v_row->>'gtis_sponsored')::boolean, false),
        v_billing_cycle,
        nullif(v_row->>'renewal_month', '')::int,
        coalesce((v_row->>'renewal_reminder')::boolean, true),
        v_created_by,
        nullif(trim(v_row->>'logo_url'), ''), nullif(trim(v_row->>'activation_url'), ''),
        nullif(trim(v_row->>'more_info_url'), ''), nullif(trim(lower(v_row->>'google_group_email')), ''),
        coalesce((v_row->>'pro_rated')::boolean, false),
        case when v_service_manager_email is null then '{}'::text[] else array[v_service_manager_email] end
      ) returning id into v_id;

      v_results := v_results || jsonb_build_object('ok', true, 'id', v_id, 'row', v_row);
    exception when others then
      v_results := v_results || jsonb_build_object('ok', false, 'error', sqlerrm, 'row', v_row);
    end;
  end loop;

  return v_results;
end;
$$;

-- ─── RPC: admin_import_subscriptions_full ──────────────────────────────────────
-- Distinct from admin_import_subscriptions() above: that one is a quick
-- "just get currently-active seats in the door" tool that forces status =
-- 'active' and fabricates a single 'imported' audit row. This one preserves
-- the GAS row's real historical status/dates/billing fields verbatim, and
-- does NOT write any audit_log row itself — the real historical trail comes
-- in separately via admin_import_audit_log, and duplicating a synthetic
-- entry on top of it would just clutter that trail.
--
-- "Don't overwrite" is enforced two ways: skip if legacy_id already exists
-- (safe to re-run), and skip if a subscription for the same user+license+FY
-- already exists WITHOUT a legacy_id (i.e. real, live-created data — several
-- users have more than one historical row for the same license+FY, e.g.
-- revoke-then-re-request, so only a live/non-imported match blocks a row,
-- not another already-imported historical one).

create or replace function admin_import_subscriptions_full(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_legacy_id text;
  v_user_email text;
  v_license licenses%rowtype;
  v_raw_suite_key text;
  v_suite_key text;
  v_ministry_id text;
  v_canonical_key text;
  v_billing_type subscription_billing_type;
  v_start_date date;
  v_fy int;
  v_status subscription_status;
  v_renewal_status renewal_status;
  v_billing_cycle billing_cycle;
  v_renewal_month int;
  v_renewal_reminder boolean;
  v_price_at_signup numeric;
  v_sub_id uuid;
  v_error text;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_error := null;
      v_legacy_id := nullif(trim(v_row->>'legacy_id'), '');
      v_user_email := lower(trim(v_row->>'user_email'));
      v_license := null;
      v_suite_key := null;
      v_ministry_id := null;

      if v_legacy_id is not null and exists (select 1 from subscriptions where legacy_id = v_legacy_id) then
        v_error := 'Already imported: ' || v_legacy_id;
      end if;

      if v_error is null then
        select * into v_license from licenses
        where (nullif(v_row->>'license_legacy_id', '') is not null and legacy_id = v_row->>'license_legacy_id')
           or lower(name) = lower(trim(v_row->>'license_name'))
        limit 1;
        if v_license.id is null then
          v_error := 'License not found: ' || (v_row->>'license_name');
        end if;
      end if;

      if v_error is null then
        v_fy := (v_row->>'fy')::int;
        if exists (
          select 1 from subscriptions
          where user_email = v_user_email and license_id = v_license.id and fy = v_fy and legacy_id is null
        ) then
          v_error := 'Live subscription already exists for this user/license/FY';
        end if;
      end if;

      if v_error is null then
        v_raw_suite_key := regexp_replace(trim(coalesce(v_row->>'suite_key', '')), '~.*$', '');

        if v_raw_suite_key = 'GTIS' or (v_license.gtis_sponsored and v_raw_suite_key = '') then
          v_billing_type := 'gtis';
        elsif v_raw_suite_key ~* '^(MIN:)?\d{6}$' then
          v_ministry_id := regexp_replace(v_raw_suite_key, '^MIN:', '', 'i');
          v_billing_type := 'ministry';
        elsif v_raw_suite_key = '' then
          v_error := 'Missing SuiteKey/Ministry ID';
        else
          v_billing_type := 'suite_key';
          select suite_key into v_canonical_key from suite_keys where lower(suite_key) = lower(v_raw_suite_key);
          v_suite_key := coalesce(v_canonical_key, v_raw_suite_key);
          if v_canonical_key is null then
            insert into suite_keys (suite_key, owner_email) values (v_suite_key, null);
          end if;
        end if;
      end if;

      if v_error is not null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', v_error, 'row', v_row);
        continue;
      end if;

      v_start_date := to_date(split_part(v_row->>'start_date', ' ', 1), 'FMMM/FMDD/YYYY');
      v_status := (v_row->>'status')::subscription_status;
      v_renewal_status := coalesce(nullif(v_row->>'renewal_status', '')::renewal_status, 'none');
      v_billing_cycle := coalesce(nullif(v_row->>'billing_cycle', '')::billing_cycle, v_license.billing_cycle);
      v_renewal_month := coalesce(nullif(v_row->>'renewal_month', '')::int, v_license.renewal_month);
      v_renewal_reminder := coalesce(nullif(v_row->>'renewal_reminder', '')::boolean, v_license.renewal_reminder);
      v_price_at_signup := nullif(v_row->>'price_at_signup', '')::numeric;

      -- Must precede the subscriptions insert below — subscriptions.ministry_id
      -- has an FK into ministry_ids(ministry_id), so the row has to exist first.
      if v_ministry_id is not null then
        insert into ministry_ids (email, ministry_id) values (v_user_email, v_ministry_id)
          on conflict (email) do update set ministry_id = excluded.ministry_id;
      end if;

      insert into subscriptions (
        legacy_id, user_email, license_id, suite_key, billing_type, ministry_id, start_date, activated_at, fy, status,
        renewal_status, billing_cycle, renewal_month, renewal_reminder, price_at_signup
      ) values (
        v_legacy_id, v_user_email, v_license.id, v_suite_key, v_billing_type, v_ministry_id, v_start_date,
        (case when v_status = 'active' then v_start_date else null end), v_fy, v_status,
        v_renewal_status, v_billing_cycle, v_renewal_month, v_renewal_reminder, v_price_at_signup
      ) returning id into v_sub_id;

      v_results := v_results || jsonb_build_object('ok', true, 'id', v_sub_id, 'row', v_row);
    exception when others then
      v_results := v_results || jsonb_build_object('ok', false, 'error', sqlerrm, 'row', v_row);
    end;
  end loop;

  return v_results;
end;
$$;

-- ─── RPC: admin_import_audit_log ───────────────────────────────────────────────
-- Purely additive — every historical action GAS ever logged maps directly
-- onto the existing audit_action enum, no remapping needed. subscription_id
-- resolves via the legacy_id stamped by admin_import_subscriptions_full
-- above; if it can't resolve (e.g. that importer hasn't been run, or this
-- row's subscription genuinely isn't in the export), the row still imports
-- with a null subscription_id and the legacy id preserved in notes instead
-- of being silently dropped.

create or replace function admin_import_audit_log(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_legacy_id text;
  v_sub_legacy_id text;
  v_sub_id uuid;
  v_notes text;
  v_error text;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_error := null;
      v_legacy_id := nullif(trim(v_row->>'legacy_id'), '');

      if v_legacy_id is not null and exists (select 1 from audit_log where legacy_id = v_legacy_id) then
        v_error := 'Already imported: ' || v_legacy_id;
      end if;

      if v_error is not null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', v_error, 'row', v_row);
        continue;
      end if;

      v_sub_legacy_id := nullif(trim(v_row->>'subscription_legacy_id'), '');
      v_sub_id := null;
      v_notes := nullif(v_row->>'notes', '');
      if v_sub_legacy_id is not null then
        select id into v_sub_id from subscriptions where legacy_id = v_sub_legacy_id;
        if v_sub_id is null then
          v_notes := '[legacy ' || v_sub_legacy_id || '] ' || coalesce(v_notes, '');
        end if;
      end if;

      insert into audit_log (
        legacy_id, created_at, action, subscription_id, license_name, user_email, suite_key, performed_by, notes
      ) values (
        v_legacy_id,
        to_timestamp(v_row->>'timestamp', 'FMMM/FMDD/YYYY FMHH24:MI:SS'),
        (v_row->>'action')::audit_action,
        v_sub_id, nullif(v_row->>'license_name', ''), lower(trim(v_row->>'user_email')),
        nullif(v_row->>'suite_key', ''), lower(trim(v_row->>'performed_by')), v_notes
      );

      v_results := v_results || jsonb_build_object('ok', true, 'row', v_row);
    exception when others then
      v_results := v_results || jsonb_build_object('ok', false, 'error', sqlerrm, 'row', v_row);
    end;
  end loop;

  return v_results;
end;
$$;

-- ─── RPC: admin_set_role ────────────────────────────────────────────────────────
-- The only sanctioned way a profile's role can change now — see the fix to
-- profiles' "own update" RLS policy in schema.sql, which now blocks changing
-- role via a direct client-side update (nothing previously stopped a signed-
-- in user from just updating their own role that way — this closes that).
--
-- Refuses to demote the last remaining admin, so the app can never end up
-- with zero admins and nobody able to fix it without raw SQL.

create or replace function admin_set_role(p_profile_id uuid, p_role user_role)
returns void language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;

  if p_role = 'member' and (select role from profiles where id = p_profile_id) = 'admin' then
    if (select count(*) from profiles where role = 'admin') <= 1 then
      raise exception 'cannot demote the last remaining admin';
    end if;
  end if;

  update profiles set role = p_role where id = p_profile_id;
end;
$$;

-- ─── Function EXECUTE grants (keep at the end of this file) ──────────────────
-- Postgres grants EXECUTE to PUBLIC on every new function, so without this
-- anyone holding the public anon key could call every RPC above. Revoke from
-- PUBLIC and anon on every function this app defines, then grant back to
-- authenticated/service_role. Add new RPCs to v_rpcs. Two exceptions:
--   - Functions referenced by RLS policies must stay executable by whoever
--     runs the query (including anon, e.g. the announcements banner), so
--     they're left alone. They only answer questions about the caller, and
--     since is_admin() never returns NULL they answer "no" for anon.
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
    'approve_renewal', 'approve_subscription', 'calc_prorated_cost', 'calendar_month_span',
    'calendar_month_span_exact', 'can_approve_renewal_for_key', 'cancel_subscription', 'confirm_sk_ownership',
    'create_link_token', 'current_client_ip', 'deactivate_license', 'decline_renewal', 'decline_subscription',
    'deny_sk_ownership', 'fy_boundary_months',
    'get_admin_emails', 'get_area_discounted_price', 'get_finance_export', 'get_last_team_import',
    'get_my_pending_approvals', 'get_my_pending_provisioning', 'get_my_pending_renewal_approvals',
    'get_my_pending_sk_verifications',
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


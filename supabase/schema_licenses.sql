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
--   - Requesting a subscription on behalf of someone else (GAS allowed
--     UserEmail != requester); this schema only supports self-service
--     requests for now.
--
-- Since ported: Catalog.gs's finance export and bulk CSV import
-- (calc_prorated_cost/get_finance_export, admin_import_subscriptions below),
-- and Managers.gs's org-hierarchy "my team's subscriptions" view
-- (get_report_emails, My Team page).

-- ─── ENUMS ───────────────────────────────────────────────────────────────────

create type subscription_status as enum (
  'pending_sk_verification', 'pending', 'approved', 'active',
  'declined', 'revoked', 'cancelled'
);
create type renewal_status as enum ('none', 'opted_in', 'opted_out');
-- renewal_month/renewal_reminder are only meaningful for 'annual' billing.
-- 'one_time' is for non-recurring purchases (e.g. an OS license bought
-- outright) and never renews; 'monthly' prorates by day-of-month instead
-- (see calc_prorated_cost() below) rather than renewing on a calendar month.
-- Both should be left null/false — nothing enforces that at the DB level,
-- the admin UI just hides those fields unless 'annual' is selected.
create type billing_cycle as enum ('annual', 'monthly', 'one_time');
create type audit_action as enum (
  'requested', 'auto_approved', 'approved', 'declined',
  'activated', 'revoked', 'cancelled', 'sk_verified', 'imported', 'sk_merged'
);
-- Which billing path a subscription used. Replaces the original GAS-ported
-- design of overloading suite_key with the literal strings 'GTIS' /
-- 'MIN:XXXXXX' — that broke the suite_key FK below, since neither value is
-- ever a real row in suite_keys. suite_key/ministry_id are only populated
-- for their matching billing_type; both are null for 'gtis'.
create type subscription_billing_type as enum ('suite_key', 'gtis', 'ministry');

-- ─── PROFILE EXTENSIONS ──────────────────────────────────────────────────────
-- Needed so RPCs below can join subscriptions/licenses (keyed by email) back
-- to a profile. The base template's profiles.primary_email has no unique
-- constraint; add one here since this app relies on email-based lookups.

alter table profiles add column if not exists department text;
alter table profiles add column if not exists manager_email text;
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
  created_at      timestamptz not null default now()
);

-- Belt-and-suspenders against the class of bug where a case-mismatched
-- SuiteKey (e.g. "relations-u_sil" vs "Relations-U_SIL") silently creates a
-- second, unowned row instead of matching the real one. request_subscription()
-- and admin_update_suite_key_owner() both normalize to the existing row's
-- casing before writing, but this index turns any path that doesn't into a
-- loud constraint error instead of quietly corrupting data.
create unique index if not exists suite_keys_lower_suite_key_idx on suite_keys (lower(suite_key));

-- Cache of Google Group membership, refreshed on a schedule by the
-- sync-group-memberships Edge Function (a domain-wide-delegated service
-- account, narrowly scoped to admin.directory.group[.member].readonly).
-- RLS can't make live calls to Google's API, so authorization checks read
-- this cache rather than querying Directory API per-request. Only ever
-- populated for groups actually referenced as a suite_keys.owner_group_email —
-- not a sync of the whole organization's group directory.
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
  service_manager_email text,
  onboarding_message   text,   -- overrides the default "your license is ready" activation email body for this license
  created_at           timestamptz not null default now()
);

-- Subscription / request records.
create table if not exists subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  user_email            text not null,
  license_id            uuid not null references licenses(id),
  suite_key             text references suite_keys(suite_key),
  billing_type          subscription_billing_type not null default 'suite_key',
  ministry_id           text references ministry_ids(ministry_id),
  start_date            date not null default current_date,
  fy                    int not null,
  status                subscription_status not null default 'pending',
  renewal_status        renewal_status not null default 'none',
  billing_cycle         billing_cycle,
  renewal_month         int,
  renewal_reminder      boolean,
  pending_approver_email text,
  price_at_signup       numeric,
  requested_by          uuid references profiles(id),
  created_at            timestamptz not null default now()
);

create index if not exists subscriptions_user_email_idx on subscriptions (user_email);
create index if not exists subscriptions_suite_key_idx on subscriptions (suite_key);
create index if not exists subscriptions_license_id_idx on subscriptions (license_id);

-- FY renewal opt-in log (append-only; opt-outs are not logged here, only as
-- subscriptions.renewal_status = 'opted_out').
create table if not exists renewals (
  id             uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  fiscal_year    int not null,
  opt_in_date    date not null default current_date,
  opted_in_by    text,
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
  notes          text
);

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
  error          text
);

create index if not exists email_log_subscription_id_idx on email_log (subscription_id);

create index if not exists audit_log_subscription_id_idx on audit_log (subscription_id);
create index if not exists audit_log_suite_key_idx on audit_log (suite_key);

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────────────

alter table suite_keys enable row level security;
alter table ministry_ids enable row level security;
alter table licenses enable row level security;
alter table subscriptions enable row level security;
alter table renewals enable row level security;
alter table audit_log enable row level security;
alter table email_log enable row level security;
alter table group_memberships enable row level security;

-- Helpers

create or replace function current_profile_email()
returns text language sql stable security definer as $$
  select primary_email from profiles where id = current_profile_id()
$$;

create or replace function is_admin()
returns boolean language sql stable security definer as $$
  select get_profile_role() = 'admin'
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
    where id = p_license_id and service_manager_email = current_profile_email()
  )
$$;

create or replace function is_service_manager_any()
returns boolean language sql stable security definer as $$
  select exists(select 1 from licenses where service_manager_email = current_profile_email())
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

-- Policies

create policy "suite_keys: owner or admin read" on suite_keys for select
  using (is_suite_key_owner(suite_key) or is_admin());
create policy "suite_keys: admin write" on suite_keys for insert with check (is_admin());
create policy "suite_keys: admin update" on suite_keys for update using (is_admin());

create policy "group_memberships: admin read" on group_memberships for select using (is_admin());
-- No client write policy — only sync-group-memberships (service-role key) writes here.

create policy "ministry_ids: own or admin read" on ministry_ids for select
  using (email = current_profile_email() or is_admin());

create policy "licenses: read active, or own scope" on licenses for select
  using (active or is_admin() or service_manager_email = current_profile_email());
create policy "licenses: admin write" on licenses for all
  using (is_admin()) with check (is_admin());

create policy "subscriptions: read own or authority" on subscriptions for select
  using (
    user_email = current_profile_email()
    or is_admin()
    or (suite_key is not null and is_suite_key_owner(suite_key))
    or is_service_manager_for(license_id)
    or lower(user_email) in (select get_report_emails())
  );
-- All writes go through the security-definer RPCs below, which enforce
-- status-transition and authority checks themselves; no direct write
-- policies are needed for non-admins.
create policy "subscriptions: admin write" on subscriptions for all
  using (is_admin()) with check (is_admin());

create policy "renewals: read via subscription" on renewals for select
  using (
    exists (
      select 1 from subscriptions s where s.id = subscription_id
        and (s.user_email = current_profile_email() or is_admin()
             or (s.suite_key is not null and is_suite_key_owner(s.suite_key)))
    )
  );

create policy "audit_log: admin read all" on audit_log for select using (is_admin());
create policy "audit_log: suite key owner read own" on audit_log for select
  using (suite_key is not null and is_suite_key_owner(suite_key));
create policy "audit_log: user read own" on audit_log for select
  using (user_email = current_profile_email());

create policy "email_log: admin read" on email_log for select using (is_admin());
-- No insert/update policies for authenticated — only the send-email Edge
-- Function writes here, via the service-role key (which bypasses RLS).

-- ─── RPC: request_subscription ────────────────────────────────────────────────
-- Mirrors Subscriptions.gs createSubscription(). Branches on GTIS-sponsored /
-- ministry-ID / suite-key paths to decide the initial status.

create or replace function request_subscription(
  p_license_id uuid,
  p_suite_key text,
  p_suggested_approver_email text,
  p_ministry_id text,
  p_fy int
) returns uuid language plpgsql security definer as $$
declare
  v_license licenses%rowtype;
  v_email text := current_profile_email();
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
begin
  if v_email is null then raise exception 'not authenticated'; end if;

  select * into v_license from licenses where id = p_license_id and active;
  if v_license.id is null then raise exception 'license not found or inactive'; end if;

  if exists (
    select 1 from subscriptions
    where user_email = v_email and license_id = p_license_id and fy = p_fy
      and status not in ('declined', 'revoked', 'cancelled')
  ) then
    raise exception 'a subscription for this license already exists for this fiscal year';
  end if;

  if v_license.gtis_sponsored then
    v_billing_type := 'gtis';
    v_audit_suite_key := 'GTIS';
    v_status := case when v_license.activation_url is not null then 'approved' else 'active' end;

  elsif p_ministry_id is not null then
    if p_ministry_id !~ '^\d{6}$' then
      raise exception 'ministry ID must be exactly 6 digits';
    end if;
    v_billing_type := 'ministry';
    v_ministry_id := p_ministry_id;
    v_audit_suite_key := 'MIN:' || p_ministry_id;
    insert into ministry_ids (email, ministry_id) values (v_email, p_ministry_id)
      on conflict (email) do update set ministry_id = excluded.ministry_id;
    v_status := case when v_license.activation_url is not null then 'approved' else 'active' end;

  else
    v_billing_type := 'suite_key';
    if p_suite_key is null then raise exception 'a suite key is required'; end if;
    -- Trim here to match admin_update_suite_key_owner()'s trim before its
    -- suite_keys upsert — a stray leading/trailing space on this insert
    -- would otherwise create a row that upsert can never match again later,
    -- since Postgres treats "key" and "key " as distinct primary key text.
    v_suite_key := trim(p_suite_key);
    if v_suite_key like '%~%' then
      raise exception 'SuiteKey cannot contain "~" — check for stray text pasted in after the real key';
    end if;

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
        select 1 from group_memberships where group_email = v_owner_group and member_email = v_email
      ) then
        v_status := case when v_license.activation_url is not null then 'approved' else 'active' end;
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
      v_status := 'pending_sk_verification';
      v_pending_approver := p_suggested_approver_email;
    elsif v_owner = v_email then
      v_status := case when v_license.activation_url is not null then 'approved' else 'active' end;
    else
      v_status := 'pending';
    end if;
  end if;

  insert into subscriptions (
    user_email, license_id, suite_key, billing_type, ministry_id, fy, status, billing_cycle,
    renewal_month, renewal_reminder, price_at_signup, pending_approver_email, requested_by
  ) values (
    v_email, p_license_id, v_suite_key, v_billing_type, v_ministry_id, p_fy, v_status, v_license.billing_cycle,
    v_license.renewal_month, v_license.renewal_reminder, v_license.price, v_pending_approver, current_profile_id()
  ) returning id into v_sub_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by)
  values (
    (case when v_status in ('active', 'approved') then 'auto_approved' else 'requested' end)::audit_action,
    v_sub_id, v_license.name, v_email, v_audit_suite_key, v_email
  );

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
returns table(id uuid, user_email text, license_name text)
language plpgsql security definer as $$
declare v_email text := current_profile_email();
begin
  -- Also succeeds if already owned by the caller (idempotent) — an admin
  -- may have already assigned this key to them via admin_update_suite_key_owner(),
  -- in which case they're just confirming/advancing re-pointed requests, not
  -- claiming an unowned key.
  update suite_keys set owner_email = v_email
  where suite_key = p_suite_key and (owner_email is null or owner_email = v_email);
  if not found then raise exception 'suite key not found or owned by someone else'; end if;

  insert into audit_log (action, suite_key, performed_by)
  values ('sk_verified', p_suite_key, v_email);

  return query
    update subscriptions s
    set status = 'pending', pending_approver_email = null
    from licenses l
    where s.suite_key = p_suite_key and s.status = 'pending_sk_verification'
      and s.pending_approver_email = v_email and l.id = s.license_id
    returning s.id, s.user_email, l.name;
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

create or replace function admin_confirm_sk_ownership(p_suite_key text, p_owner_email text)
returns table(id uuid, user_email text, license_name text)
language plpgsql security definer as $$
declare
  v_owner text := nullif(lower(trim(p_owner_email)), '');
  v_admin text := current_profile_email();
begin
  if not is_admin() then raise exception 'admin only'; end if;
  p_suite_key := trim(p_suite_key);
  if v_owner is null then raise exception 'owner email is required'; end if;

  update suite_keys set owner_email = v_owner, owner_group_email = null
  where suite_key = p_suite_key;
  if not found then raise exception 'suite key not found'; end if;

  insert into audit_log (action, suite_key, performed_by)
  values ('sk_verified', p_suite_key, v_admin);

  return query
    update subscriptions s
    set status = 'pending', pending_approver_email = null
    from licenses l
    where s.suite_key = p_suite_key and s.status = 'pending_sk_verification'
      and s.pending_approver_email = v_owner and l.id = s.license_id
    returning s.id, s.user_email, l.name;
end;
$$;

drop function if exists deny_sk_ownership(text);

create or replace function deny_sk_ownership(p_suite_key text)
returns table(id uuid, user_email text, license_name text)
language plpgsql security definer as $$
declare v_email text := current_profile_email();
begin
  insert into audit_log (action, suite_key, performed_by, notes)
  values ('declined', p_suite_key, v_email, 'suite key ownership declined');

  return query
    update subscriptions s
    set status = 'declined'
    from licenses l
    where s.suite_key = p_suite_key and s.status = 'pending_sk_verification'
      and s.pending_approver_email = v_email and l.id = s.license_id
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
  p_suite_key text, p_new_owner_email text, p_description text default null, p_owner_group_email text default null
) returns table(id uuid, user_email text, license_name text)
language plpgsql security definer as $$
declare
  v_owner text := nullif(lower(trim(p_new_owner_email)), '');
  v_group text := nullif(lower(trim(p_owner_group_email)), '');
  v_canonical_key text;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  p_suite_key := trim(p_suite_key);
  if p_suite_key = '' then raise exception 'suite key is required'; end if;
  if p_suite_key like '%~%' then
    raise exception 'SuiteKey cannot contain "~" — check for stray text pasted in after the real key';
  end if;
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

  insert into suite_keys (suite_key, owner_email, owner_group_email, description)
  values (p_suite_key, v_owner, v_group, p_description)
  on conflict (suite_key) do update
    set owner_email = v_owner,
        owner_group_email = v_group,
        description = coalesce(p_description, suite_keys.description);

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

-- ─── RPC: admin_merge_suite_key ────────────────────────────────────────────────
-- For data-entry mistakes: someone types e.g. "Relations-U_SIL~5407" (garbage
-- appended, a paste artifact, a typo) instead of the real "Relations-U_SIL".
-- That's a genuinely different suite_keys row from request_subscription()'s
-- perspective — not a case/whitespace variant the earlier fixes catch — so it
-- creates a real, separate, unowned key. There was previously no way to
-- delete it: subscriptions.suite_key's FK blocks a plain delete while any
-- subscription still points at it. This repoints those subscriptions to the
-- correct key first, then deletes the bad row.
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
    select s.id, s.user_email, l.activation_url
    from subscriptions s join licenses l on l.id = s.license_id
    where s.suite_key = v_correct and s.status = 'pending_sk_verification'
  loop
    if v_owner_group is not null then
      if exists (select 1 from group_memberships where group_email = v_owner_group and member_email = r.user_email) then
        update subscriptions set status = (case when r.activation_url is not null then 'approved' else 'active' end)::subscription_status, pending_approver_email = null where id = r.id;
      else
        update subscriptions set status = 'pending', pending_approver_email = null where id = r.id;
      end if;
    elsif v_owner is not null then
      if v_owner = r.user_email then
        update subscriptions set status = (case when r.activation_url is not null then 'approved' else 'active' end)::subscription_status, pending_approver_email = null where id = r.id;
      else
        update subscriptions set status = 'pending', pending_approver_email = null where id = r.id;
      end if;
    end if;
    -- else: the correct key is itself still unowned — leave it in
    -- pending_sk_verification, genuinely still awaiting a suggested approver.
  end loop;

  insert into audit_log (action, suite_key, performed_by, notes)
  values ('sk_merged', v_correct, current_profile_email(), 'merged from "' || v_bad || '"');

  delete from suite_keys where suite_key = v_bad;
end;
$$;

-- ─── RPC: approve_subscription / decline_subscription ─────────────────────────

create or replace function approve_subscription(p_subscription_id uuid)
returns void language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_sub subscriptions%rowtype;
  v_license licenses%rowtype;
  v_new_status subscription_status;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status != 'pending' then raise exception 'subscription is not pending approval'; end if;
  if not (is_admin() or is_suite_key_owner(v_sub.suite_key)) then
    raise exception 'not authorized to approve this subscription';
  end if;

  select * into v_license from licenses where id = v_sub.license_id;
  v_new_status := case when v_license.activation_url is not null then 'approved' else 'active' end;

  update subscriptions set status = v_new_status where id = p_subscription_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by)
  values ('approved', p_subscription_id, v_license.name, v_sub.user_email, v_sub.suite_key, v_email);
end;
$$;

create or replace function decline_subscription(p_subscription_id uuid, p_notes text default null)
returns void language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_sub subscriptions%rowtype;
  v_license_name text;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status not in ('pending', 'pending_sk_verification') then
    raise exception 'subscription is not awaiting approval';
  end if;
  if not (
    is_admin()
    or (v_sub.suite_key is not null and is_suite_key_owner(v_sub.suite_key))
    or v_sub.pending_approver_email = v_email
  ) then
    raise exception 'not authorized to decline this subscription';
  end if;

  select name into v_license_name from licenses where id = v_sub.license_id;
  update subscriptions set status = 'declined' where id = p_subscription_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes)
  values ('declined', p_subscription_id, v_license_name, v_sub.user_email, v_sub.suite_key, v_email, p_notes);
end;
$$;

-- ─── RPC: activate_subscription / cancel_subscription / revoke_subscription ──

create or replace function activate_subscription(p_subscription_id uuid, p_price numeric default null)
returns void language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_sub subscriptions%rowtype;
  v_license licenses%rowtype;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status != 'approved' then raise exception 'subscription is not approved'; end if;

  select * into v_license from licenses where id = v_sub.license_id;
  if not (is_admin() or v_license.service_manager_email = v_email) then
    raise exception 'not authorized to activate this subscription';
  end if;

  update subscriptions
  set status = 'active', price_at_signup = coalesce(p_price, price_at_signup)
  where id = p_subscription_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes)
  values (
    'activated', p_subscription_id, v_license.name, v_sub.user_email, v_sub.suite_key, v_email,
    case when v_license.google_group_email is not null
      then 'TODO: add ' || v_sub.user_email || ' to ' || v_license.google_group_email || ' (not automated yet)'
      else null end
  );
end;
$$;

create or replace function cancel_subscription(p_subscription_id uuid)
returns void language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_sub subscriptions%rowtype;
  v_license_name text;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status not in ('pending', 'pending_sk_verification', 'approved', 'active') then
    raise exception 'subscription cannot be cancelled from its current status';
  end if;
  if not (is_admin() or v_sub.user_email = v_email) then
    raise exception 'not authorized to cancel this subscription';
  end if;

  select name into v_license_name from licenses where id = v_sub.license_id;
  update subscriptions set status = 'cancelled' where id = p_subscription_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by)
  values ('cancelled', p_subscription_id, v_license_name, v_sub.user_email, v_sub.suite_key, v_email);
end;
$$;

create or replace function revoke_subscription(p_subscription_id uuid)
returns void language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_sub subscriptions%rowtype;
  v_license_name text;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status != 'active' then raise exception 'subscription is not active'; end if;
  if not (is_admin() or (v_sub.suite_key is not null and is_suite_key_owner(v_sub.suite_key))) then
    raise exception 'not authorized to revoke this subscription';
  end if;

  select name into v_license_name from licenses where id = v_sub.license_id;
  update subscriptions set status = 'revoked' where id = p_subscription_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by)
  values ('revoked', p_subscription_id, v_license_name, v_sub.user_email, v_sub.suite_key, v_email);
end;
$$;

-- ─── RPC: opt_in_renewal / opt_out_renewal ─────────────────────────────────────

create or replace function opt_in_renewal(p_subscription_id uuid)
returns void language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_sub subscriptions%rowtype;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if not (is_admin() or v_sub.user_email = v_email) then raise exception 'not authorized'; end if;

  update subscriptions set renewal_status = 'opted_in' where id = p_subscription_id;
  insert into renewals (subscription_id, fiscal_year, opted_in_by)
  values (p_subscription_id, v_sub.fy, v_email);
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

  update subscriptions set renewal_status = 'opted_out' where id = p_subscription_id;
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

-- ─── RPC: save_license / deactivate_license (admin catalog CRUD) ─────────────

create or replace function save_license(p_license jsonb)
returns uuid language plpgsql security definer as $$
declare v_id uuid;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  v_id := (p_license->>'id')::uuid;
  if v_id is null then
    insert into licenses (
      name, vendor, category, price, price_unit, notes, gtis_sponsored,
      billing_cycle, renewal_month, renewal_reminder, logo_url, activation_url,
      more_info_url, google_group_email, pro_rated, service_manager_email,
      onboarding_message, created_by
    ) values (
      p_license->>'name', p_license->>'vendor', p_license->>'category',
      (p_license->>'price')::numeric, p_license->>'price_unit', p_license->>'notes',
      coalesce((p_license->>'gtis_sponsored')::boolean, false),
      coalesce((p_license->>'billing_cycle')::billing_cycle, 'annual'),
      (p_license->>'renewal_month')::int,
      coalesce((p_license->>'renewal_reminder')::boolean, true),
      p_license->>'logo_url', p_license->>'activation_url', p_license->>'more_info_url',
      p_license->>'google_group_email', coalesce((p_license->>'pro_rated')::boolean, false),
      p_license->>'service_manager_email', nullif(p_license->>'onboarding_message', ''), current_profile_id()
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
      service_manager_email = p_license->>'service_manager_email',
      onboarding_message = nullif(p_license->>'onboarding_message', '')
    where id = v_id;
  end if;

  return v_id;
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
    return round(p_price * v_days_left / v_days_in_month, 2);
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

create or replace function get_finance_export(p_start_date date, p_end_date date)
returns table(
  user_email text, license_name text, billing_label text, cost numeric, start_date date, status text
) language sql stable as $$
  select
    s.user_email,
    l.name,
    case
      when s.billing_type = 'gtis' then 'GTIS'
      when s.billing_type = 'ministry' then 'Ministry ID ' || s.ministry_id
      else s.suite_key
    end,
    calc_prorated_cost(l.price, l.billing_cycle, l.renewal_month, l.pro_rated, s.start_date),
    s.start_date,
    s.status::text
  from subscriptions s
  join licenses l on l.id = s.license_id
  where s.status in ('active', 'approved')
    and s.start_date >= p_start_date
    and s.start_date <= p_end_date
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
-- fy}: suite_key accepts a real SuiteKey, a 6-digit Ministry ID (bare or
-- "MIN:XXXXXX"), or blank for a GTIS-sponsored license. Applies the same
-- SuiteKey trim/tilde-block/case-insensitive-match rules as
-- request_subscription(), for the same reasons — and the same FY rollover
-- rule as GAS's getCurrentFiscalYear() when fy isn't given (October start).
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
      v_raw_suite_key := trim(coalesce(v_row->>'suite_key', ''));
      v_billing_type := null;
      v_suite_key := null;
      v_ministry_id := null;
      v_license := null;

      if v_user_email = '' or v_user_email is null then
        v_error := 'Missing email';
      elsif v_user_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
        v_error := 'Invalid email';
      elsif v_license_name = '' or v_license_name is null then
        v_error := 'Missing license name';
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
          if v_raw_suite_key like '%~%' then
            v_error := 'SuiteKey cannot contain "~"';
          else
            select suite_key into v_canonical_key from suite_keys where lower(suite_key) = lower(v_raw_suite_key);
            v_suite_key := coalesce(v_canonical_key, v_raw_suite_key);
            if v_canonical_key is null then
              insert into suite_keys (suite_key, owner_email) values (v_suite_key, null);
            end if;
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
        user_email, license_id, suite_key, billing_type, ministry_id, fy, status,
        billing_cycle, renewal_month, renewal_reminder, price_at_signup, requested_by
      ) values (
        v_user_email, v_license.id, v_suite_key, v_billing_type, v_ministry_id, v_fy, 'active',
        v_license.billing_cycle, v_license.renewal_month, v_license.renewal_reminder, v_license.price, current_profile_id()
      ) returning id into v_sub_id;

      if v_ministry_id is not null then
        insert into ministry_ids (email, ministry_id) values (v_user_email, v_ministry_id)
          on conflict (email) do update set ministry_id = excluded.ministry_id;
      end if;

      insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes)
      values (
        'imported', v_sub_id, v_license.name, v_user_email,
        case when v_billing_type = 'gtis' then 'GTIS' when v_billing_type = 'ministry' then 'MIN:' || v_ministry_id else v_suite_key end,
        v_admin, 'imported from legacy system'
      );

      v_results := v_results || jsonb_build_object('ok', true, 'id', v_sub_id, 'row', v_row);
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

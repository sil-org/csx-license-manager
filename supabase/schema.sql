-- ─── SIL APP TEMPLATE — AUTH KERNEL ─────────────────────────────────────────
-- Run this in the Supabase SQL Editor (Project > SQL Editor > New query).
-- Safe to re-run: uses CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE throughout.
--
-- This is the reusable core: profiles, multi-Google-account linking, and
-- role-based RLS. Add your app-specific tables in a separate migration file
-- and reference profiles(id) as the source of truth for "who is this".

-- Roles: extend this enum with whatever roles your app needs (e.g. 'reviewer').
-- Postgres has no CREATE TYPE IF NOT EXISTS, so this is guarded with a
-- do-block that swallows "already exists" — same pattern as the enums in
-- schema_licenses.sql — to keep this file's "safe to re-run" claim true.
do $$ begin
  create type user_role as enum ('member', 'admin');
exception when duplicate_object then null; end $$;

-- ─── PROFILES ────────────────────────────────────────────────────────────────
-- One row per real human. Everything in the system references this table,
-- not Supabase auth.users, so multiple Google accounts can map to one person.

create table if not exists profiles (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null,
  primary_email text not null,
  role          user_role not null default 'member',
  created_at    timestamptz not null default now()
);

-- ─── LINKED ACCOUNTS ─────────────────────────────────────────────────────────
-- Maps Supabase auth user IDs (one per Google account) to a profile.
-- A profile can have multiple linked accounts.

create table if not exists linked_accounts (
  supabase_user_id  uuid primary key,  -- matches auth.users.id
  profile_id        uuid not null references profiles(id) on delete cascade,
  email             text not null,
  linked_at         timestamptz not null default now()
);

create index if not exists linked_accounts_profile_id_idx on linked_accounts(profile_id);

-- ─── PROFILE LINK TOKENS ─────────────────────────────────────────────────────
-- Short-lived tokens used to link a second Google account to an existing profile.
-- Flow: signed-in user generates a token (createLinkToken), stores it in
-- localStorage, then signs in with a second Google account. resolveProfile()
-- picks up the token and redeems it via the resolve_profile RPC below.

create table if not exists profile_link_tokens (
  token       uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '15 minutes',
  used_at     timestamptz
);

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────────────

alter table profiles enable row level security;
alter table linked_accounts enable row level security;
alter table profile_link_tokens enable row level security;

-- Helper: get the profile_id for the currently authenticated Supabase user
create or replace function current_profile_id()
returns uuid
language sql stable security definer
as $$
  select profile_id
  from linked_accounts
  where supabase_user_id = auth.uid()
  limit 1
$$;

-- Helper: get the role for the currently authenticated user
create or replace function get_profile_role()
returns user_role
language sql stable security definer
as $$
  select role
  from profiles
  where id = current_profile_id()
$$;

-- "SIL staff" isn't limited to @sil.org — it also covers a handful of
-- SIL-affiliated domains (mirrors gas-legacy's ALLOWED_DOMAINS). Central
-- here so resolve_profile() (sign-in) and request_subscription() (license
-- requests, in schema_licenses.sql) apply the exact same eligibility rule.
create or replace function is_eligible_staff_email(p_email text)
returns boolean language sql immutable as $$
  select lower(split_part(p_email, '@', 2)) in (
    'sil.org', 'hipaa.sil.org', 'ethnologue.com', 'scriptsource.org',
    'email7.net', 'i55seed.com', 'koastal.net', 'mailrapide.com',
    'pike34.net', 'sall.com', 'spbangladesh.org'
  )
$$;

-- profiles: users can read and update their own; admins can read all
drop policy if exists "profiles: own read" on profiles;
create policy "profiles: own read"
  on profiles for select
  using (id = current_profile_id() or get_profile_role() = 'admin');

-- with check blocks changing role via this policy specifically — nothing
-- previously stopped a signed-in user from just updating their own role to
-- 'admin' via a direct client-side call. Role changes now only happen
-- through a security-definer RPC (e.g. admin_set_role() in the domain
-- schema), which bypasses RLS as the table owner and is unaffected by this.
drop policy if exists "profiles: own update" on profiles;
create policy "profiles: own update"
  on profiles for update
  using (id = current_profile_id())
  with check (id = current_profile_id() and role = get_profile_role());

-- The own-update policy above still lets a user rewrite every other column
-- of their own row — and apps on this project authorize by email, manager
-- and department. This trigger rejects client-side changes to those columns;
-- security-definer RPCs run as the function owner and are unaffected.
-- Compared via to_jsonb so columns an app doesn't have are simply no-ops.
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

-- linked_accounts: users can read their own; admins can read all
drop policy if exists "linked_accounts: own read" on linked_accounts;
create policy "linked_accounts: own read"
  on linked_accounts for select
  using (profile_id = current_profile_id() or get_profile_role() = 'admin');

-- No insert policy: rows are only ever created by resolve_profile(), a
-- security definer RPC. (A `with check (true)` policy used to live here,
-- which let any signed-in user link themselves to any profile directly.)
drop policy if exists "linked_accounts: insert own" on linked_accounts;

drop policy if exists "linked_accounts: admin update" on linked_accounts;
create policy "linked_accounts: admin update"
  on linked_accounts for update
  using (get_profile_role() = 'admin');

-- profile_link_tokens: users can read/insert their own
drop policy if exists "link_tokens: own read" on profile_link_tokens;
create policy "link_tokens: own read" on profile_link_tokens for select
  using (profile_id = current_profile_id());
drop policy if exists "link_tokens: own insert" on profile_link_tokens;
create policy "link_tokens: own insert" on profile_link_tokens for insert
  with check (profile_id = current_profile_id());

-- ─── RPC: resolve_profile ────────────────────────────────────────────────────
-- Called on every sign-in (see src/lib/auth.js). Three cases:
--   1. This Google account is already linked to a profile      -> return it.
--   2. A valid, unused link token was passed                   -> link this
--      account to that token's profile (multi-account linking) and return it.
--   3. Neither                                                 -> create a new
--      profile for this person and link this account to it.
--
-- SIL-staff-only enforcement lives here, enabled below — but only on case 3
-- (brand new profile creation). Case 2 (linking a second account to an
-- existing profile) is deliberately exempt: the link token is itself the
-- security check there. A token can only be generated by someone already
-- signed in to a profile, and a profile can only ever have been created via
-- an eligible-staff email (case 3, see is_eligible_staff_email() above), so
-- redeeming a valid token is proof enough — regardless of the second
-- account's domain. This is what lets staff link a personal Google account
-- (e.g. a personal Gmail) as backup sign-in access before they lose their
-- SIL email, while still blocking anyone without a valid token from
-- creating a profile with an ineligible address.
--
-- Identity always comes from the session (auth.uid() and that user's
-- auth.users row), never from the parameters — p_supabase_user_id/p_email/
-- p_display_name are kept only so existing callers don't break, and are
-- ignored. Trusting them let any signed-in user link to any profile.
--
-- This function is shared with the helpdesk app (same Supabase project) —
-- keep the two repos' copies of this file in sync.

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

-- ─── RPC: create_link_token ───────────────────────────────────────────────────
-- Lets a signed-in user generate a token to link a second Google account.

create or replace function create_link_token()
returns uuid language plpgsql security definer as $$
declare v_token uuid;
begin
  if current_profile_id() is null then raise exception 'not authenticated'; end if;
  insert into profile_link_tokens (profile_id)
  values (current_profile_id())
  returning token into v_token;
  return v_token;
end;
$$;

-- ─── MAKE YOURSELF ADMIN ─────────────────────────────────────────────────────
-- After your first login, run this in the SQL Editor to grant yourself admin.
-- Replace the email with your own Google account email.
--
-- update profiles set role = 'admin'
-- where primary_email = 'your-email@sil.org';

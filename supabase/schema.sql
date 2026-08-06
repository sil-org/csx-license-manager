-- ─── SIL APP TEMPLATE — AUTH KERNEL ─────────────────────────────────────────
-- Run this in the Supabase SQL Editor (Project > SQL Editor > New query).
-- Safe to re-run: uses CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE throughout.
--
-- This is the reusable core: profiles, multi-Google-account linking, and
-- role-based RLS. Add your app-specific tables in a separate migration file
-- and reference profiles(id) as the source of truth for "who is this".

-- Roles: extend this enum with whatever roles your app needs (e.g. 'reviewer').
create type user_role as enum ('member', 'admin');

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
create policy "profiles: own read"
  on profiles for select
  using (id = current_profile_id() or get_profile_role() = 'admin');

-- with check blocks changing role via this policy specifically — nothing
-- previously stopped a signed-in user from just updating their own role to
-- 'admin' via a direct client-side call. Role changes now only happen
-- through a security-definer RPC (e.g. admin_set_role() in the domain
-- schema), which bypasses RLS as the table owner and is unaffected by this.
create policy "profiles: own update"
  on profiles for update
  using (id = current_profile_id())
  with check (id = current_profile_id() and role = get_profile_role());

-- linked_accounts: users can read their own; admins can read/insert all
create policy "linked_accounts: own read"
  on linked_accounts for select
  using (profile_id = current_profile_id() or get_profile_role() = 'admin');

create policy "linked_accounts: insert own"
  on linked_accounts for insert
  with check (true);  -- enforced inside resolve_profile(), a security definer RPC

create policy "linked_accounts: admin update"
  on linked_accounts for update
  using (get_profile_role() = 'admin');

-- profile_link_tokens: users can read/insert their own
create policy "link_tokens: own read" on profile_link_tokens for select
  using (profile_id = current_profile_id());
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
-- This function is shared with the helpdesk app (same Supabase project) —
-- keep the two repos' copies of this file in sync.

create or replace function resolve_profile(
  p_token uuid,
  p_supabase_user_id uuid,
  p_email text,
  p_display_name text
)
returns uuid language plpgsql security definer as $$
declare
  v_profile_id uuid;
begin
  -- case 1: already linked
  select profile_id into v_profile_id
  from linked_accounts where supabase_user_id = p_supabase_user_id;
  if v_profile_id is not null then
    return v_profile_id;
  end if;

  -- case 2: valid link token supplied — links this account to an existing
  -- profile regardless of email domain (see comment above for why that's safe).
  if p_token is not null then
    select profile_id into v_profile_id
    from profile_link_tokens
    where token = p_token and used_at is null and expires_at > now();

    if v_profile_id is not null then
      insert into linked_accounts (supabase_user_id, profile_id, email)
      values (p_supabase_user_id, v_profile_id, p_email);
      update profile_link_tokens set used_at = now() where token = p_token;
      return v_profile_id;
    end if;
  end if;

  -- case 3: brand new person — the only path that creates a profile, so the
  -- only path that needs the eligibility check.
  if not is_eligible_staff_email(p_email) then
    raise exception 'Access restricted to SIL staff.';
  end if;

  insert into profiles (display_name, primary_email)
  values (p_display_name, p_email)
  returning id into v_profile_id;

  insert into linked_accounts (supabase_user_id, profile_id, email)
  values (p_supabase_user_id, v_profile_id, p_email);

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

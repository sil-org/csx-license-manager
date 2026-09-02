-- Run this in the Supabase SQL Editor.
--
-- Feature: let an admin repoint an existing subscription onto a different
-- SuiteKey from Admin -> All Subscriptions' details modal — e.g. it was
-- billed against the wrong key, or the underlying budget moved to a new one.
-- This deliberately never touches the subscription's status or
-- activated_at — an admin fixing which key pays for an already-active
-- subscription is not the same as re-requesting/re-approving it, and
-- nothing about its provisioning state should reset. It does still email
-- the new key's owner (or, if unclaimed, a suggested approver the admin
-- supplies) so they're aware a request now sits against their key — same
-- approval_request/sk_verification emails request_subscription() sends,
-- just without gating this subscription on the response.
--
-- Since the subscription's own status can't change, an unclaimed new key's
-- pending ownership claim can't live on subscriptions.pending_approver_email/
-- status = 'pending_sk_verification' the way request_subscription() tracks
-- it — that column pair is inherently a per-subscription status. Instead it
-- lives on the SuiteKey itself: suite_keys.pending_owner_email/
-- pending_owner_is_group. admin_confirm_sk_ownership() and
-- admin_update_suite_key_owner() are extended to also resolve/clear these
-- columns, and getSuiteKeys() (src/lib/admin.js) already surfaces them as a
-- "pending" SuiteKey with the same one-click "Confirm as {approver}" action
-- it offers for a subscription-sourced pending claim.

alter table suite_keys
  add column if not exists pending_owner_email text,
  add column if not exists pending_owner_is_group boolean not null default false;

alter type audit_action add value if not exists 'suite_key_updated';

-- ─── RPC: admin_update_subscription_suite_key ──────────────────────────────────

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
  where suite_key = v_new_key;

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

-- ─── RPC: admin_confirm_sk_ownership ────────────────────────────────────────────
-- Now also resolves a key-level pending claim (suite_keys.pending_owner_email,
-- set by admin_update_subscription_suite_key() above) when there's no
-- matching pending_sk_verification subscription to fall back on, and clears
-- both pending_owner_* columns once confirmed either way.

create or replace function admin_confirm_sk_ownership(p_suite_key text, p_owner_email text)
returns table(id uuid, user_email text, license_name text, more_info_url text)
language plpgsql security definer as $$
declare
  v_owner text := nullif(lower(trim(p_owner_email)), '');
  v_admin text := current_profile_email();
  v_is_group boolean;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  p_suite_key := trim(p_suite_key);
  if v_owner is null then raise exception 'owner email is required'; end if;

  select bool_or(pending_approver_is_group) into v_is_group
  from subscriptions
  where suite_key = p_suite_key and status = 'pending_sk_verification' and pending_approver_email = v_owner;

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

-- ─── RPC: admin_update_suite_key_owner ──────────────────────────────────────────
-- Clears any key-level pending_owner_email/pending_owner_is_group claim
-- whenever this admin action actually resolves ownership directly — an
-- explicit admin-assigned owner supersedes a still-outstanding suggested
-- approver. Left untouched when unassigning (both p_new_owner_email and
-- p_owner_group_email blank), since that doesn't resolve anything.

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
  p_suite_key := regexp_replace(trim(p_suite_key), '~.*$', '');
  if p_suite_key = '' then raise exception 'suite key is required'; end if;
  if v_owner is not null and v_group is not null then
    raise exception 'a suite key can have an individual owner or a group owner, not both';
  end if;

  select suite_key into v_canonical_key from suite_keys where lower(suite_key) = lower(p_suite_key);
  if v_canonical_key is not null then
    p_suite_key := v_canonical_key;
  end if;

  insert into suite_keys (suite_key, owner_email, owner_group_email, description)
  values (p_suite_key, v_owner, v_group, p_description)
  on conflict (suite_key) do update
    set owner_email = v_owner,
        owner_group_email = v_group,
        description = coalesce(p_description, suite_keys.description),
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

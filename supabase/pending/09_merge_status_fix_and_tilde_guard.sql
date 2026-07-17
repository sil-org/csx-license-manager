-- Run this in the Supabase SQL Editor.
--
-- Two fixes:
--   1. admin_merge_suite_key() only repointed suite_key — it never re-evaluated
--      status, so a subscription merged onto an already-owned key stayed
--      stuck in pending_sk_verification even though ownership is no longer
--      in question. This replaces that function to also advance status,
--      the same way request_subscription() would have decided it in the
--      first place.
--   2. Blocks "~" in a SuiteKey at both entry points (Catalog requests and
--      Admin's "+ New SuiteKey") — that's what produced
--      "Relations-U_SIL~5407" to begin with.
--
-- STEP 1 — one-time fix for the Relations-U_SIL subscription already stuck
-- from before this fix existed (safe to run even if there's nothing to fix):

update subscriptions s
set status = (case when l.activation_url is not null then 'approved' else 'active' end)::subscription_status,
    pending_approver_email = null
from licenses l
where s.license_id = l.id
  and s.suite_key = 'Relations-U_SIL'
  and s.status = 'pending_sk_verification'
  and s.user_email = (select owner_email from suite_keys where suite_key = 'Relations-U_SIL');

update subscriptions
set status = 'pending', pending_approver_email = null
where suite_key = 'Relations-U_SIL' and status = 'pending_sk_verification';

-- STEP 2 — the actual fixes, so this can't recur:

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

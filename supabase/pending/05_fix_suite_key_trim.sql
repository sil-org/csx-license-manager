-- Run this in the Supabase SQL Editor. Fixes a real bug found in testing:
-- request_subscription() never trimmed the SuiteKey text before storing/
-- matching it, while admin_update_suite_key_owner() does trim before its
-- suite_keys upsert. A SuiteKey typed with a stray leading/trailing space
-- (e.g. "kate's key ") got stored untrimmed — the row worked fine for
-- display, but the first admin action that trims it (Confirm, or any future
-- edit) hits a *different* primary key text and inserts a brand-new row
-- instead of updating the original one. That's what caused "confirming a
-- pending SuiteKey also created another one".
--
-- Cleanup for the specific rows this already caused ("kate's key", one
-- untrimmed/unowned + one trimmed/owned) — check the exact text first:
--
--   select suite_key, owner_email, owner_group_email, created_at
--   from suite_keys where suite_key ilike '%kate%key%' order by created_at;
--
-- then delete whichever row is the untrimmed leftover (the unowned one,
-- older created_at) and update any subscriptions still pointing at it:
--
--   update subscriptions set suite_key = 'kate''s key' where suite_key = 'kate''s key ';
--   delete from suite_keys where suite_key = 'kate''s key ';
--
-- (adjust the exact strings above to match what the SELECT actually shows —
-- the stray whitespace won't be visible, only present in the raw text)

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
    v_audit_suite_key := v_suite_key;

    select owner_email, owner_group_email into v_owner, v_owner_group from suite_keys where suite_key = v_suite_key;
    if not found then
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

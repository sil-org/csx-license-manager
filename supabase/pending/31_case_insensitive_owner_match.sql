-- Bug: requesting a license against a SuiteKey you already own didn't
-- always land on 'approved' the way it's supposed to — it fell through to
-- 'pending' instead, needing your own approval on a request you'd clearly
-- already authorize by virtue of owning the budget key.
--
-- Root cause: current_profile_email() returns profiles.primary_email
-- verbatim, whatever case Google's OAuth handed back at signup — it isn't
-- normalized to lowercase. Every *other* email comparison in this file goes
-- out of its way to lowercase both sides first (admin_update_suite_key_owner,
-- admin_confirm_sk_ownership, get_report_emails, sync-group-memberships'
-- own .toLowerCase() before writing group_memberships.member_email) — but
-- request_subscription()'s three suite-key-ownership checks compared
-- v_actor_email against v_owner/v_pending_approver/member_email verbatim, so
-- any case difference (most commonly: an admin typed a SuiteKey owner's
-- email in a different case than that person's actual Google-account
-- casing) silently fell through to the "not the owner" branch instead of
-- raising an error — easy to miss, since 'pending' is a valid status too.
--
-- Fix: lowercase both sides of all three comparisons, same as everywhere
-- else in this file already does. Also lowercase what gets written to
-- suite_keys.owner_email in the self-suggested-owner path, so a
-- self-registered key matches this convention going forward.

create or replace function request_subscription(
  p_license_id uuid,
  p_suite_key text,
  p_suggested_approver_email text,
  p_ministry_id text,
  p_fy int,
  p_recipient_email text default null
) returns uuid language plpgsql security definer as $$
declare
  v_license licenses%rowtype;
  v_actor_email text := current_profile_email();
  v_recipient_email text := coalesce(nullif(trim(lower(p_recipient_email)), ''), current_profile_email());
  v_sub_id uuid;
  v_status subscription_status;
  v_billing_type subscription_billing_type;
  v_suite_key text := null;
  v_ministry_id text := null;
  v_audit_suite_key text;
  v_canonical_key text;
  v_owner text;
  v_owner_group text;
  v_pending_approver text := null;
begin
  if v_actor_email is null then raise exception 'not authenticated'; end if;
  if not is_eligible_staff_email(v_recipient_email) then
    raise exception 'License requests are only available to SIL staff.';
  end if;

  select * into v_license from licenses where id = p_license_id and active;
  if v_license.id is null then raise exception 'license not found or inactive'; end if;

  if exists (
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
    v_suite_key := regexp_replace(trim(p_suite_key), '~.*$', '');
    if v_suite_key = '' then raise exception 'a suite key is required'; end if;

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
    -- mirrors GAS's `!skExists || !skOwnerEmail` condition.
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
      end if;
    elsif lower(v_owner) = lower(v_actor_email) then
      v_status := 'approved';
    else
      v_status := 'pending';
    end if;
  end if;

  insert into subscriptions (
    user_email, license_id, suite_key, billing_type, ministry_id, fy, status, billing_cycle,
    renewal_month, renewal_reminder, price_at_signup, pending_approver_email, requested_by
  ) values (
    v_recipient_email, p_license_id, v_suite_key, v_billing_type, v_ministry_id, p_fy, v_status, v_license.billing_cycle,
    v_license.renewal_month, v_license.renewal_reminder, v_license.price, v_pending_approver, current_profile_id()
  ) returning id into v_sub_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
  values (
    'requested', v_sub_id, v_license.name, v_recipient_email, v_audit_suite_key, v_actor_email,
    case when v_recipient_email <> v_actor_email then 'on behalf of ' || v_recipient_email else null end,
    current_client_ip()
  );

  if v_status = 'approved' then
    insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, ip_address)
    values ('auto_approved', v_sub_id, v_license.name, v_recipient_email, v_audit_suite_key, v_actor_email, current_client_ip());
  end if;

  return v_sub_id;
end;
$$;

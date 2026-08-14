-- Run this in the Supabase SQL Editor. Lets a free license (no suite key,
-- no ministry ID — like gtis_sponsored) still require approval for specific
-- departments that opt in, instead of either always-approve (gtis_sponsored)
-- or always-need-a-suite-key. First consumer: Gemini AI access, currently
-- requested through an external Smartsheet form purely because it's free
-- and a few departments want their own sign-off on it — this replaces that
-- form with the normal in-app request flow.
--
-- The gate is fully automatic: it keys off the RECIPIENT's own `sco` (the
-- person the license is actually for, not whoever's submitting the
-- request — matters for request-on-behalf-of), checked against an
-- admin-managed opt-in table. No sco on file, or no opt-in row for that sco,
-- means auto-approved, same experience as gtis_sponsored today. Deliberately
-- reuses existing machinery rather than inventing a parallel approval
-- concept: `pending_approver_email` (already used by the suite-key
-- suggested-approver flow) records who needs to act, and
-- approve_subscription()/decline_subscription() gate on it exactly like
-- they already gate on suite-key ownership.

alter table licenses add column if not exists department_gated boolean not null default false;

create table if not exists department_approvals (
  id             uuid primary key default gen_random_uuid(),
  license_id     uuid not null references licenses(id),
  sco            text not null check (sco ~ '^[A-Z]{3}$'),
  approver_email text not null,
  created_at     timestamptz not null default now(),
  unique (license_id, sco)
);

alter table department_approvals enable row level security;
drop policy if exists "department_approvals: admin only" on department_approvals;
create policy "department_approvals: admin only" on department_approvals for all
  using (is_admin()) with check (is_admin());

alter type subscription_billing_type add value if not exists 'department';

-- ─── RPC: request_subscription — department_gated branch ────────────────────

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
  v_audit_suite_key text;  -- display-only label for the audit log; NOT written to subscriptions.suite_key
  v_canonical_key text;
  v_owner text;
  v_owner_group text;
  v_pending_approver text := null;
  v_sco text;
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

  elsif v_license.department_gated then
    -- Gate on the recipient's own department, not the requester's — a
    -- department's opt-in should apply to whoever will actually use the
    -- seat, regardless of who happened to submit the request on their
    -- behalf. No profile, or no sco on file, or no opt-in row for that sco:
    -- auto-approve, same as gtis_sponsored.
    v_billing_type := 'department';
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
    renewal_month, renewal_reminder, price_at_signup, pending_approver_email, requested_by
  ) values (
    v_recipient_email, p_license_id, v_suite_key, v_billing_type, v_ministry_id, p_fy, v_status, v_license.billing_cycle,
    v_license.renewal_month, v_license.renewal_reminder, v_license.price, v_pending_approver, current_profile_id()
  ) returning id into v_sub_id;

  -- Always log the request itself, even when it's about to be auto-approved
  -- below — otherwise an auto-approved subscription's audit trail starts
  -- with 'auto_approved' and never shows that a request happened at all.
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

-- ─── RPC: approve_subscription — authorize named department approvers too ───
-- Adds the same `pending_approver_email = v_email` clause decline_subscription()
-- already has, instead of a new is_department_approver_for() helper — the
-- approver was already resolved and snapshotted at request time above, no
-- need to re-derive it from sco/department_approvals here.

create or replace function approve_subscription(p_subscription_id uuid)
returns void language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_sub subscriptions%rowtype;
  v_license licenses%rowtype;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status != 'pending' then raise exception 'subscription is not pending approval'; end if;
  if not (is_admin() or is_suite_key_owner(v_sub.suite_key) or v_sub.pending_approver_email = v_email) then
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

-- ─── RPC: get_my_pending_approvals — surface department-approver rows too ────

create or replace function get_my_pending_approvals()
returns table(id uuid, user_email text, suite_key text, license_name text)
language sql stable security definer as $$
  select s.id, s.user_email, s.suite_key, l.name
  from subscriptions s join licenses l on l.id = s.license_id
  where s.status = 'pending'
    and (is_suite_key_owner(s.suite_key) or s.pending_approver_email = current_profile_email())
  order by s.created_at
$$;

-- ─── RPC: save_license — add department_gated (full reconciled list again;
-- see pending/38's note on why this function's body is always rewritten
-- from scratch, never diffed) ──────────────────────────────────────────────

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
      department_gated, created_by
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
      department_gated = coalesce((p_license->>'department_gated')::boolean, false)
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

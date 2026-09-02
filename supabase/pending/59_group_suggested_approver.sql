-- Run this in the Supabase SQL Editor.
--
-- Bug (2026-09-01): Alan typed operations_gslt@sil.org — a Google Group,
-- not an individual — into "suggested approver" on an unclaimed suite key.
-- The confirmation email correctly went to the group address, and Google
-- forwarded it into Alan's own inbox since he's a member. But
-- get_my_pending_sk_verifications() only ever matched an exact
-- pending_approver_email = current_profile_email() — a group address can
-- never equal any individual's own email, so nothing showed up in his
-- Action Center no matter who in that group signed in. He worked around it
-- by re-requesting with his own email instead, so nothing was actually
-- stuck, but the underlying gap remains: a group typo'd into that field is
-- silently unconfirmable by anyone.
--
-- Fix: classify the suggested-approver email client-side (see the new
-- classify-approver-email Edge Function, a Directory API groups.get
-- lookup) before calling request_subscription(), and tag the resulting
-- pending_sk_verification row with the new pending_approver_is_group flag.
-- get_my_pending_sk_verifications()/confirm_sk_ownership()/
-- deny_sk_ownership()/admin_confirm_sk_ownership() then accept any current
-- member of that group (checked against the group_memberships cache) as
-- well as an exact individual match — confirming registers the *group* as
-- the suite key's owner (owner_group_email), same trust level as an
-- individual's own self-service confirmation, just requiring any one
-- current member to do it instead of a specific named person.
--
-- Also broadens sync-group-memberships (redeploy that Edge Function after
-- running this) to keep a group named as a pending suggested approver in
-- the group_memberships cache even before it's ever claimed — otherwise
-- there'd be nothing to check membership against until an admin manually
-- assigned the key first.

alter table subscriptions
  add column if not exists pending_approver_is_group boolean not null default false;

-- ─── RPC: request_subscription ────────────────────────────────────────────────
-- Adds a 9th parameter (p_suggested_approver_is_group) — must drop the 8-arg
-- overload explicitly, since CREATE OR REPLACE only replaces a function with
-- an identical argument list.
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
  p_suggested_approver_is_group boolean default false
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
      if exists (
        select 1 from group_memberships where group_email = v_owner_group and lower(member_email) = lower(v_actor_email)
      ) then
        v_status := 'approved';
      else
        v_status := 'pending';
      end if;

    elsif v_owner is null then
      if p_suggested_approver_email is null then
        raise exception 'suite key % has no owner on file — provide a suggested approver email', v_suite_key;
      end if;
      v_pending_approver := nullif(lower(trim(p_suggested_approver_email)), '');
      if v_pending_approver = lower(v_actor_email) then
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

  insert into subscriptions (
    user_email, license_id, suite_key, billing_type, ministry_id, fy, status, billing_cycle,
    renewal_month, renewal_reminder, price_at_signup, pending_approver_email, pending_approver_is_group, requested_by, extra_field_value
  ) values (
    v_recipient_email, p_license_id, v_suite_key, v_billing_type, v_ministry_id, p_fy, v_status, v_license.billing_cycle,
    v_license.renewal_month, v_license.renewal_reminder, v_license.price, v_pending_approver, v_is_group, current_profile_id(),
    nullif(trim(p_extra_field_value), '')
  ) returning id into v_sub_id;

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

-- ─── RPC: confirm_sk_ownership ─────────────────────────────────────────────────
-- Now resolves what this suite key's pending row(s) actually name as the
-- approver — an exact individual match (unchanged, today's common path) or,
-- failing that, a group the caller currently belongs to per group_memberships.

create or replace function confirm_sk_ownership(p_suite_key text)
returns table(id uuid, user_email text, license_name text, more_info_url text)
language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_approver text;
  v_is_group boolean;
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

  if v_approver is null then raise exception 'suite key not found or owned by someone else'; end if;

  if v_is_group then
    update suite_keys set owner_group_email = v_approver, owner_email = null
    where suite_key = p_suite_key and owner_email is null and (owner_group_email is null or owner_group_email = v_approver);
  else
    update suite_keys set owner_email = v_approver, owner_group_email = null
    where suite_key = p_suite_key and (owner_email is null or owner_email = v_approver);
  end if;
  if not found then raise exception 'suite key not found or owned by someone else'; end if;

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
-- p_owner_email may itself be a group address (pending_approver_is_group) —
-- routes the claim onto owner_group_email instead of owner_email when so.

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

  if coalesce(v_is_group, false) then
    update suite_keys set owner_group_email = v_owner, owner_email = null
    where suite_key = p_suite_key;
  else
    update suite_keys set owner_email = v_owner, owner_group_email = null
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

-- ─── RPC: deny_sk_ownership ─────────────────────────────────────────────────────
-- Same individual-first, then-group-membership resolution as confirm_sk_ownership.

create or replace function deny_sk_ownership(p_suite_key text)
returns table(id uuid, user_email text, license_name text)
language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
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

-- ─── RPC: get_my_pending_sk_verifications ──────────────────────────────────────
-- Also matches "caller is a current member of a suggested group" via the
-- group_memberships cache, alongside the original exact individual match.

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

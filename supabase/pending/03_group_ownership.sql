-- Run this in the Supabase SQL Editor. Adds: Google Group-based Suite Key
-- ownership (an owner can be a Google Group instead of one individual).
-- Requires the sync-group-memberships Edge Function to actually be deployed
-- and scheduled before group-owned keys work end-to-end — see that
-- function's file header for the one-time Google Cloud / Workspace setup.

alter table suite_keys add column if not exists owner_group_email text;

create table if not exists group_memberships (
  group_email  text not null,
  member_email text not null,
  synced_at    timestamptz not null default now(),
  primary key (group_email, member_email)
);
alter table group_memberships enable row level security;
create policy "group_memberships: admin read" on group_memberships for select using (is_admin());

-- Every approve/decline/revoke RPC and the subscriptions/renewals/audit_log
-- RLS policies already call this one helper, so extending it here cascades
-- everywhere without touching each call site individually.
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

-- suite_keys' own SELECT policy should use the same helper now, so a group
-- member can see keys owned by their group too.
drop policy if exists "suite_keys: owner or admin read" on suite_keys;
create policy "suite_keys: owner or admin read" on suite_keys for select
  using (is_suite_key_owner(suite_key) or is_admin());

-- Returns both columns now (a key is owned by exactly one, never both) so
-- the caller knows whether to notify an individual or a group address.
drop function if exists get_suite_key_owner(text);

create or replace function get_suite_key_owner(p_suite_key text)
returns table(owner_email text, owner_group_email text)
language sql stable security definer as $$
  select owner_email, owner_group_email from suite_keys where suite_key = p_suite_key;
$$;

-- Extended with a group-email parameter — exactly one of p_new_owner_email /
-- p_owner_group_email may be set; passing both is an error, neither unassigns.
create or replace function admin_update_suite_key_owner(
  p_suite_key text, p_new_owner_email text, p_description text default null, p_owner_group_email text default null
) returns table(id uuid, user_email text, license_name text)
language plpgsql security definer as $$
declare
  v_owner text := nullif(lower(trim(p_new_owner_email)), '');
  v_group text := nullif(lower(trim(p_owner_group_email)), '');
begin
  if not is_admin() then raise exception 'admin only'; end if;
  p_suite_key := trim(p_suite_key);
  if p_suite_key = '' then raise exception 'suite key is required'; end if;
  if v_owner is not null and v_group is not null then
    raise exception 'a suite key can have an individual owner or a group owner, not both';
  end if;

  insert into suite_keys (suite_key, owner_email, owner_group_email, description)
  values (p_suite_key, v_owner, v_group, p_description)
  on conflict (suite_key) do update
    set owner_email = v_owner,
        owner_group_email = v_group,
        description = coalesce(p_description, suite_keys.description);

  if v_group is not null then
    -- Group ownership skips the confirm step entirely — an admin assigning
    -- a group is already authoritative, and membership itself is the check.
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

-- Extended with the group-owned branch — auto-approve if the requester is
-- already a member, otherwise 'pending' with no verification step at all.
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
  v_audit_suite_key text;
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
    v_suite_key := p_suite_key;
    v_audit_suite_key := p_suite_key;

    select owner_email, owner_group_email into v_owner, v_owner_group from suite_keys where suite_key = v_suite_key;
    if not found then
      insert into suite_keys (suite_key, owner_email) values (v_suite_key, null);
      v_owner := null;
      v_owner_group := null;
    end if;

    if v_owner_group is not null then
      if exists (
        select 1 from group_memberships where group_email = v_owner_group and member_email = v_email
      ) then
        v_status := case when v_license.activation_url is not null then 'approved' else 'active' end;
      else
        v_status := 'pending';
      end if;

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

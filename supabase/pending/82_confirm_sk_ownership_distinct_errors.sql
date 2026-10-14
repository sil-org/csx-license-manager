-- Run this in the Supabase SQL Editor.
--
-- confirm_sk_ownership() raised the same 'suite key not found or owned by
-- someone else' for two unrelated failures, so neither the caller nor an
-- admin reading the report could tell which had happened:
--
--   1. No pending_sk_verification request on this key is waiting on the
--      caller (or a group they're in) — e.g. someone else already confirmed
--      or denied it and the Action Center row was stale.
--   2. There is such a request, but the key already has a different owner,
--      so the suite_keys update matched no rows. This is the one people
--      actually hit: two requesters name different suggested approvers for
--      the same unowned key, the first approver confirms, and the second
--      approver's request is left in pending_sk_verification against a key
--      they can no longer claim (admin_update_subscription_suite_key() can
--      leave the same state when it moves a pending request onto an owned
--      key).
--
-- Each now gets its own message, and (2) names the current owner so the
-- approver knows who to talk to. Body otherwise verbatim from
-- 72_price_in_request_emails.sql; signature and return type are unchanged,
-- so CREATE OR REPLACE keeps the grants from 78_critical_auth_hardening.sql.

create or replace function confirm_sk_ownership(p_suite_key text)
returns table(id uuid, user_email text, license_name text, more_info_url text, price numeric, price_unit text)
language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_approver text;
  v_is_group boolean;
  v_current_owner text;
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

  if v_approver is null then
    raise exception 'no request on suite key % is waiting for your confirmation — it may already have been confirmed or denied; reload the page', p_suite_key;
  end if;

  if v_is_group then
    update suite_keys set owner_group_email = v_approver, owner_email = null
    where suite_key = p_suite_key and owner_email is null and (owner_group_email is null or owner_group_email = v_approver);
  else
    update suite_keys set owner_email = v_approver, owner_group_email = null
    where suite_key = p_suite_key and (owner_email is null or owner_email = v_approver);
  end if;

  if not found then
    select coalesce(owner_email, owner_group_email) into v_current_owner
    from suite_keys where suite_key = p_suite_key;
    if v_current_owner is null then
      raise exception 'suite key % does not exist', p_suite_key;
    end if;
    raise exception 'suite key % is already owned by % — ask them or an admin to handle this request', p_suite_key, v_current_owner;
  end if;

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
    returning s.id, s.user_email, l.name, l.more_info_url, l.price, l.price_unit;
end;
$$;

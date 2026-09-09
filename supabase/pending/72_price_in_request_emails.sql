-- Adds licenses.price/price_unit to the rows confirm_sk_ownership() and
-- admin_confirm_sk_ownership() return, so the approval-request email sent
-- right after (src/pages/ActionCenter.jsx handleConfirmSk, src/pages/admin/
-- SuiteKeys.jsx handleQuickConfirm) can show the SuiteKey owner what they're
-- actually approving the cost of — same idea as 21_more_info_url_in_emails.sql,
-- just for price instead of more_info_url. deny_sk_ownership() doesn't need
-- this, same reasoning as 21's.
--
-- Changing a function's return type requires dropping the old version first.
-- Bodies below are copied verbatim from their latest versions (59_group_
-- suggested_approver.sql / 62_admin_update_subscription_suite_key.sql) with
-- only the returns table(...) and returning list touched.

drop function if exists confirm_sk_ownership(text);

create or replace function confirm_sk_ownership(p_suite_key text)
returns table(id uuid, user_email text, license_name text, more_info_url text, price numeric, price_unit text)
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
    returning s.id, s.user_email, l.name, l.more_info_url, l.price, l.price_unit;
end;
$$;

drop function if exists admin_confirm_sk_ownership(text, text);

create or replace function admin_confirm_sk_ownership(p_suite_key text, p_owner_email text)
returns table(id uuid, user_email text, license_name text, more_info_url text, price numeric, price_unit text)
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
    returning s.id, s.user_email, l.name, l.more_info_url, l.price, l.price_unit;
end;
$$;

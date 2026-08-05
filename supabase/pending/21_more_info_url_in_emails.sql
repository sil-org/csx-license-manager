-- Adds licenses.more_info_url to the rows confirm_sk_ownership() and
-- admin_confirm_sk_ownership() return, so the approval-request email sent
-- right after (src/pages/Approvals.jsx handleConfirmSk, src/pages/admin/
-- SuiteKeys.jsx handleQuickConfirm) can include a "More info" link. The
-- other advance-returning RPC, deny_sk_ownership(), doesn't need it — its
-- caller sends skOwnershipDeniedEmailHtml, which was never in scope for
-- this link. Changing a function's return type requires dropping the old
-- version first (same as when these were first changed to return rows
-- instead of void).

drop function if exists confirm_sk_ownership(text);

create or replace function confirm_sk_ownership(p_suite_key text)
returns table(id uuid, user_email text, license_name text, more_info_url text)
language plpgsql security definer as $$
declare v_email text := current_profile_email();
begin
  update suite_keys set owner_email = v_email
  where suite_key = p_suite_key and (owner_email is null or owner_email = v_email);
  if not found then raise exception 'suite key not found or owned by someone else'; end if;

  insert into audit_log (action, suite_key, performed_by, ip_address)
  values ('sk_verified', p_suite_key, v_email, current_client_ip());

  return query
    update subscriptions s
    set status = 'pending', pending_approver_email = null
    from licenses l
    where s.suite_key = p_suite_key and s.status = 'pending_sk_verification'
      and s.pending_approver_email = v_email and l.id = s.license_id
    returning s.id, s.user_email, l.name, l.more_info_url;
end;
$$;

drop function if exists admin_confirm_sk_ownership(text, text);

create or replace function admin_confirm_sk_ownership(p_suite_key text, p_owner_email text)
returns table(id uuid, user_email text, license_name text, more_info_url text)
language plpgsql security definer as $$
declare
  v_owner text := nullif(lower(trim(p_owner_email)), '');
  v_admin text := current_profile_email();
begin
  if not is_admin() then raise exception 'admin only'; end if;
  p_suite_key := trim(p_suite_key);
  if v_owner is null then raise exception 'owner email is required'; end if;

  update suite_keys set owner_email = v_owner, owner_group_email = null
  where suite_key = p_suite_key;
  if not found then raise exception 'suite key not found'; end if;

  insert into audit_log (action, suite_key, performed_by, ip_address)
  values ('sk_verified', p_suite_key, v_admin, current_client_ip());

  return query
    update subscriptions s
    set status = 'pending', pending_approver_email = null
    from licenses l
    where s.suite_key = p_suite_key and s.status = 'pending_sk_verification'
      and s.pending_approver_email = v_owner and l.id = s.license_id
    returning s.id, s.user_email, l.name, l.more_info_url;
end;
$$;

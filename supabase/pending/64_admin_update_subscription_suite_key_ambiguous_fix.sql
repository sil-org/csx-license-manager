-- Fixes admin_update_subscription_suite_key() (62): its RETURNS TABLE(suite_key
-- text, ...) declares an implicit "suite_key" variable in the function's own
-- scope, which collides with the suite_keys.suite_key column referenced
-- unqualified in the pending-owner UPDATE below — Postgres can't tell which
-- one you mean and raises "column reference \"suite_key\" is ambiguous" on
-- every repoint attempt where the new key has no owner yet. Qualify it.
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
  where suite_keys.suite_key = v_new_key;

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

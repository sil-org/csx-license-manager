-- Cosmetic only, no behavior change to the RPC itself: removes the
-- "TODO: add ... to ... (not automated yet)" audit-log note that
-- activate_subscription() wrote for licenses with google_group_email set.
-- Now that supabase/functions/sync-provisioning's google_group pass (see
-- adapters/google-group.ts) actually does this automatically, kicked from
-- the same UI action that calls this RPC, the note is stale and would be
-- actively misleading in the audit trail going forward.

create or replace function activate_subscription(p_subscription_id uuid, p_price numeric default null)
returns void language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_sub subscriptions%rowtype;
  v_license licenses%rowtype;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status != 'approved' then raise exception 'subscription is not approved'; end if;

  select * into v_license from licenses where id = v_sub.license_id;
  if not (is_admin() or v_license.service_manager_email = v_email) then
    raise exception 'not authorized to activate this subscription';
  end if;

  update subscriptions
  set status = 'active', price_at_signup = coalesce(p_price, price_at_signup)
  where id = p_subscription_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, ip_address)
  values ('activated', p_subscription_id, v_license.name, v_sub.user_email, v_sub.suite_key, v_email, current_client_ip());
end;
$$;

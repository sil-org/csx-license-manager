-- Wires up cancel/revoke buttons on two pages that were read-only before:
-- My Team (a people manager cancelling a direct/indirect report's
-- subscription) and SuiteKey Charges (a SuiteKey owner revoking an active
-- subscription charged to their key — revoke_subscription() already existed
-- and was already correctly authorized for this, it just had no UI yet).

-- Is p_email one of the current user's direct/indirect reports — backs
-- cancel_subscription()'s manager authorization (My Team's "Cancel" button).
-- Reuses get_report_emails() rather than re-walking manager_email itself, so
-- the two stay in lockstep by construction.
create or replace function is_manager_of(p_email text)
returns boolean language sql stable security definer as $$
  select lower(p_email) in (select get_report_emails())
$$;

create or replace function cancel_subscription(p_subscription_id uuid, p_reason text default null)
returns void language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_sub subscriptions%rowtype;
  v_license_name text;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status not in ('pending', 'pending_sk_verification', 'approved', 'active') then
    raise exception 'subscription cannot be cancelled from its current status';
  end if;
  -- is_manager_of() covers My Team's "Cancel" button — a people manager
  -- cancelling a direct/indirect report's subscription.
  if not (is_admin() or v_sub.user_email = v_email or is_service_manager_for(v_sub.license_id) or is_manager_of(v_sub.user_email)) then
    raise exception 'not authorized to cancel this subscription';
  end if;

  select name into v_license_name from licenses where id = v_sub.license_id;
  update subscriptions set status = 'cancelled' where id = p_subscription_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
  values ('cancelled', p_subscription_id, v_license_name, v_sub.user_email, v_sub.suite_key, v_email, p_reason, current_client_ip());
end;
$$;

-- Adds an optional reason, mirroring cancel_subscription()'s p_reason — the
-- SuiteKey Charges "Revoke" button prompts for one the same way Admin -> All
-- Subscriptions' "Cancel" button does.
create or replace function revoke_subscription(p_subscription_id uuid, p_reason text default null)
returns void language plpgsql security definer as $$
declare
  v_email text := current_profile_email();
  v_sub subscriptions%rowtype;
  v_license_name text;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if v_sub.status != 'active' then raise exception 'subscription is not active'; end if;
  if not (is_admin() or (v_sub.suite_key is not null and is_suite_key_owner(v_sub.suite_key))) then
    raise exception 'not authorized to revoke this subscription';
  end if;

  select name into v_license_name from licenses where id = v_sub.license_id;
  update subscriptions set status = 'revoked' where id = p_subscription_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
  values ('revoked', p_subscription_id, v_license_name, v_sub.user_email, v_sub.suite_key, v_email, p_reason, current_client_ip());
end;
$$;

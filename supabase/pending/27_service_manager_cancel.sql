-- Lets a license's service manager (licenses.service_manager_email) cancel a
-- subscription to that license, same as an admin or the subscriber
-- themselves already could — and lets any of them optionally record why, so
-- the subscriber can be told (see cancelledEmailHtml in src/lib/email.js).
-- Status whitelist is unchanged: still only the 4 non-terminal statuses.

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
  if not (is_admin() or v_sub.user_email = v_email or is_service_manager_for(v_sub.license_id)) then
    raise exception 'not authorized to cancel this subscription';
  end if;

  select name into v_license_name from licenses where id = v_sub.license_id;
  update subscriptions set status = 'cancelled' where id = p_subscription_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
  values ('cancelled', p_subscription_id, v_license_name, v_sub.user_email, v_sub.suite_key, v_email, p_reason, current_client_ip());
end;
$$;

-- Backs a new "Subscriptions you manage" section on the Action Center page —
-- every subscription (any status, not just ones awaiting the caller's next
-- action) for a license the caller service-manages. Deliberately does NOT
-- also check is_admin(), same reasoning as get_my_pending_approvals()/
-- get_my_pending_sk_verifications() (see 19_scope_approvals_to_owned_keys.sql)
-- — an admin who manages no licenses should see an empty list here, not
-- every subscription company-wide via RLS's admin bypass.
create or replace function get_my_service_managed_subscriptions()
returns table(
  id uuid, user_email text, suite_key text, ministry_id text, status subscription_status,
  fy int, billing_cycle billing_cycle, billing_type subscription_billing_type,
  activated_at date, created_at timestamptz, license_id uuid, license_name text
)
language sql stable security definer as $$
  select s.id, s.user_email, s.suite_key, s.ministry_id, s.status,
         s.fy, s.billing_cycle, s.billing_type,
         s.activated_at, s.created_at, s.license_id, l.name
  from subscriptions s
  join licenses l on l.id = s.license_id
  where is_service_manager_for(s.license_id)
  order by s.created_at desc
$$;

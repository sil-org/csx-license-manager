-- Fixes a bug hit in the wild: requesting a license for someone else who
-- isn't your direct report (not a manager relationship, not admin, not the
-- license's service manager) creates the subscription fine — the insert
-- runs inside request_subscription(), a security-definer RPC — but the
-- follow-up client-side re-select in requestSubscription() (subscriptions.js)
-- that reads the row back to figure out who to notify is subject to RLS,
-- which the actor fails. That makes .single() throw PGRST116 ("Cannot
-- coerce the result to a single JSON object"), even though the subscription
-- was created. Retrying then hits the "already exists for this fiscal year"
-- guard, because it's already there from the first attempt.
--
-- Fix: let the RLS select policy also allow the actor who submitted the
-- request (subscriptions.requested_by) to read the row back, same as it
-- already allows the subscriber themselves, admins, service managers, etc.

drop policy if exists "subscriptions: read own or authority" on subscriptions;
create policy "subscriptions: read own or authority" on subscriptions for select
  using (
    user_email = current_profile_email()
    or is_admin()
    or (suite_key is not null and is_suite_key_owner(suite_key))
    or is_service_manager_for(license_id)
    or lower(user_email) in (select get_report_emails())
    or requested_by = current_profile_id()
  );

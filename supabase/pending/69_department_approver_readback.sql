-- Fixes "cannot coerce the result to a single JSON object" (PGRST116) when a
-- department approver (pending_approver_email — see department_gated
-- licenses, pending/40) approves or declines a subscription. approve_
-- subscription()/decline_subscription() already authorize the write via
-- `pending_approver_email = current_profile_email()`, but the subscriptions
-- SELECT policy never gained the matching read clause — so the immediate
-- client-side re-select in approveSubscription()/declineSubscription()
-- (src/lib/approvals.js), used to build the notification email, hits 0 rows
-- under RLS and .single() throws. The write itself always succeeded — this
-- only broke the follow-up notification-email step. Mirrors the existing
-- `requested_by = current_profile_id()` clause, which grants the same kind
-- of permanent after-the-fact read access to the person who acted.
drop policy if exists "subscriptions: read own or authority" on subscriptions;
create policy "subscriptions: read own or authority" on subscriptions for select
  using (
    user_email = current_profile_email()
    or is_admin()
    or (suite_key is not null and is_suite_key_owner(suite_key))
    or is_service_manager_for(license_id)
    or lower(user_email) in (select get_report_emails())
    or requested_by = current_profile_id()
    or pending_approver_email = current_profile_email()
  );

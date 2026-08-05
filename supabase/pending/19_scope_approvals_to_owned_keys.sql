-- Run this in the Supabase SQL Editor. Fixes the Approvals page showing every
-- pending SuiteKey verification/approval company-wide to admins, instead of
-- just the ones they personally own or were suggested as approver for.
--
-- getPendingSkVerifications()/getPendingApprovals() (src/lib/approvals.js)
-- were plain selects relying entirely on RLS — and subscriptions' "read own
-- or authority" policy includes `or is_admin()`, so an admin saw literally
-- every pending row, not just their own. That's a read-scoping bug, not a
-- security one (is_admin() correctly grants the underlying RPCs authority
-- to act on any row too) — but it made the Approvals page unusable as "here's
-- what needs MY attention" for anyone who's also an admin.
--
-- These two RPCs deliberately do NOT check is_admin() — they scope strictly
-- to what the RPCs a user would click next (confirm_sk_ownership,
-- approve_subscription/decline_subscription) actually authorize for a
-- non-admin, so nothing shown here is ever a dead end. Admins needing to act
-- on someone else's key already have dedicated tools elsewhere (Admin ->
-- SuiteKeys' "Confirm as {suggested approver}", or admin_merge_suite_key).

create or replace function get_my_pending_sk_verifications()
returns table(id uuid, user_email text, suite_key text, license_name text)
language sql stable security definer as $$
  select s.id, s.user_email, s.suite_key, l.name
  from subscriptions s join licenses l on l.id = s.license_id
  where s.status = 'pending_sk_verification'
    and s.pending_approver_email = current_profile_email()
  order by s.created_at
$$;

create or replace function get_my_pending_approvals()
returns table(id uuid, user_email text, suite_key text, license_name text)
language sql stable security definer as $$
  select s.id, s.user_email, s.suite_key, l.name
  from subscriptions s join licenses l on l.id = s.license_id
  where s.status = 'pending'
    and is_suite_key_owner(s.suite_key)
  order by s.created_at
$$;

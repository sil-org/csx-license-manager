-- Run this in the Supabase SQL Editor.
--
-- Bug: a non-admin service manager (e.g. Jeff Schmidt for CrashPlan) had no
-- way to discover that a seat was waiting on them to provision. Action
-- Center only ever queried pending SK verifications and pending approvals
-- (get_my_pending_sk_verifications / get_my_pending_approvals) — provisioning
-- was deliberately left off it, routed instead to Admin -> All Subscriptions,
-- which service managers can already reach (is_service_manager_for grants
-- row access there) but had no reason to visit speculatively.
--
-- Fix: add get_my_pending_provisioning(), mirroring the shape/security of
-- the other two Action Center RPCs, scoped to subscriptions awaiting
-- provisioning (status = 'approved') on a license the caller manages.

create or replace function get_my_pending_provisioning()
returns table(id uuid, user_email text, suite_key text, license_name text)
language sql stable security definer as $$
  select s.id, s.user_email, s.suite_key, l.name
  from subscriptions s join licenses l on l.id = s.license_id
  where s.status = 'approved'
    and is_service_manager_for(s.license_id)
  order by s.created_at
$$;

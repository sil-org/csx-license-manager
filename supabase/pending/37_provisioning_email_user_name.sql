-- Run this in the Supabase SQL Editor. Adds get_display_name(), a narrow
-- RLS-bypassing lookup used by the "provisioning required" email — the
-- client needs the seat's user's display name (not just their email, which
-- is all subscriptions.user_email carries) so whoever provisions the seat
-- manually has a name to type into the vendor portal. Same pattern as
-- get_admin_emails() in 12_provisioning_notifications.sql: a non-admin
-- service manager can't read another user's profiles row directly (see
-- "profiles: own read" in schema.sql).

create or replace function get_display_name(p_email text)
returns text
language sql stable security definer as $$
  select display_name from profiles where lower(primary_email) = lower(p_email) limit 1;
$$;

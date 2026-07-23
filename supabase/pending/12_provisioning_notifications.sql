-- Run this in the Supabase SQL Editor. Adds get_admin_emails(), a narrow
-- RLS-bypassing lookup used by the new "provisioning required" email flow —
-- when a license needing provisioning has no service_manager_email set, the
-- client falls back to notifying admins, but can't read the profiles table
-- itself to find them (see comment in schema_licenses.sql for why).

create or replace function get_admin_emails()
returns setof text
language sql stable security definer as $$
  select primary_email from profiles where role = 'admin' and primary_email is not null;
$$;

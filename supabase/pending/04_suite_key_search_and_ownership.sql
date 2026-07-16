-- Run this in the Supabase SQL Editor. Adds two RPCs found missing during
-- today's testing round:
--
--   1. get_my_suite_keys() — fixes SuiteKey Charges showing every Suite Key
--      in the system to admins, instead of just the ones they actually own.
--      (suite_keys' RLS policy correctly returns every row to an admin, but
--      that's not the same thing as "Suite Keys I own".)
--
--   2. search_suite_keys(p_query) — typeahead support for the Catalog
--      request form. Requesters need to search *any* Suite Key (not just
--      ones they own) to avoid creating duplicates, so this bypasses RLS for
--      just this lookup — but deliberately never returns owner_email or
--      owner_group_email, only whether the key already has an owner.

create or replace function get_my_suite_keys()
returns setof text language sql stable security definer as $$
  select suite_key from suite_keys where is_suite_key_owner(suite_key)
$$;

create or replace function search_suite_keys(p_query text)
returns table(suite_key text, description text, has_owner boolean)
language sql stable security definer as $$
  select suite_key, description, (owner_email is not null or owner_group_email is not null) as has_owner
  from suite_keys
  where suite_key ilike '%' || trim(p_query) || '%'
  order by suite_key
  limit 10
$$;

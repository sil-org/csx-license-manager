-- Single-call replace-and-reconcile entry point for the Pipedream sync.
-- Pipedream can't easily do "delete everything, then bulk-insert, then call
-- a second RPC" as three separate authenticated HTTP calls without risking
-- suite_keys_current sitting empty/half-written between steps if one fails
-- — so this takes the day's full SuiteKey export as one JSON array, and
-- does replace + reconcile in a single transaction.
--
-- p_rows shape: [{"suite_key": "...", "ou_code": "...", "cost_center": "..."}, ...]
-- (only suite_key is required; ou_code/cost_center may be null/absent)
create or replace function refresh_suite_keys_current(p_rows jsonb)
returns table (added int, deprecated int, undeprecated int)
language plpgsql security definer as $$
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;
  -- Same reasoning as reconcile_suite_keys_from_current()'s own empty
  -- check: an empty export almost certainly means the Pipedream sync
  -- failed, not that the source system genuinely lists zero SuiteKeys.
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'p_rows is empty — refusing to wipe suite_keys_current; check today''s Pipedream export before retrying';
  end if;

  delete from suite_keys_current;

  insert into suite_keys_current (suite_key, ou_code, cost_center)
  select r->>'suite_key', r->>'ou_code', r->>'cost_center'
  from jsonb_array_elements(p_rows) as r
  where nullif(trim(r->>'suite_key'), '') is not null;

  return query select * from reconcile_suite_keys_from_current();
end;
$$;

revoke execute on function refresh_suite_keys_current(jsonb) from anon, authenticated;

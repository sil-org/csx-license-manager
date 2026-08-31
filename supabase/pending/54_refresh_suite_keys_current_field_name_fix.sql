-- Fixes refresh_suite_keys_current() (52/53): the Pipedream payload's key
-- field is actually named "suitekey" (no underscore) — matching the source
-- system's own field name — while this function was reading "suite_key"
-- (matching our column name). Every row's extraction came back null, got
-- filtered out by the not-null guard, and suite_keys_current ended up
-- empty even though p_rows itself wasn't, which is why only the reconcile
-- step's empty check fired. Accept either spelling so this doesn't depend
-- on Pipedream renaming the field before sending it.
create or replace function refresh_suite_keys_current(p_rows jsonb)
returns table (added int, deprecated int, undeprecated int)
language plpgsql security definer as $$
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'p_rows is empty — refusing to wipe suite_keys_current; check today''s Pipedream export before retrying';
  end if;

  delete from suite_keys_current where suite_key is not null;

  insert into suite_keys_current (suite_key, ou_code, cost_center)
  select coalesce(r->>'suite_key', r->>'suitekey'), r->>'ou_code', r->>'cost_center'
  from jsonb_array_elements(p_rows) as r
  where nullif(trim(coalesce(r->>'suite_key', r->>'suitekey')), '') is not null;

  return query select * from reconcile_suite_keys_from_current();
end;
$$;

revoke execute on function refresh_suite_keys_current(jsonb) from anon, authenticated;

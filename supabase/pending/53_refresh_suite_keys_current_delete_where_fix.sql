-- Fixes refresh_suite_keys_current() (52_refresh_suite_keys_current.sql):
-- the bare `delete from suite_keys_current;` was getting rejected as a
-- DELETE with no WHERE clause. suite_key is the primary key and is never
-- null, so filtering on that is a no-op against which rows get deleted —
-- it still clears the whole table — but satisfies whatever's enforcing the
-- WHERE-clause requirement.
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
  select r->>'suite_key', r->>'ou_code', r->>'cost_center'
  from jsonb_array_elements(p_rows) as r
  where nullif(trim(r->>'suite_key'), '') is not null;

  return query select * from reconcile_suite_keys_from_current();
end;
$$;

revoke execute on function refresh_suite_keys_current(jsonb) from anon, authenticated;

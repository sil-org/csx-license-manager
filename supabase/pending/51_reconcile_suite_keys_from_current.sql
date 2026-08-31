-- Reconciles suite_keys against the daily suite_keys_current snapshot (see
-- 50_suite_keys_current_staging.sql): adds suite_keys rows for keys new to
-- the source system, stamps deprecated_at on suite_keys rows that have
-- fallen out of the source system, and clears deprecated_at on any that
-- have reappeared. Matches case-insensitively, same as request_subscription()
-- and admin_update_suite_key_owner() elsewhere in this file — the source
-- system's casing for a key may not match what's already stored here.
--
-- Meant to run as service_role, as the last step of the Pipedream sync (or
-- a pg_cron job scheduled shortly after it) — not from the app, so unlike
-- every other admin RPC in this file it does not gate on is_admin(); an
-- authenticated app user has no reason to call this at all. Execute is
-- revoked from anon/authenticated below so only the service-role key can.
create or replace function reconcile_suite_keys_from_current()
returns table (added int, deprecated int, undeprecated int)
language plpgsql security definer as $$
declare
  v_added int;
  v_deprecated int;
  v_undeprecated int;
begin
  -- An empty snapshot almost certainly means today's Pipedream sync failed
  -- partway (e.g. the delete ran but the insert didn't) rather than the
  -- source system genuinely listing zero SuiteKeys — refuse rather than
  -- deprecating every row in suite_keys. Same reasoning as
  -- sync-group-memberships treating "API call failed" differently from
  -- "group genuinely has zero members".
  if not exists (select 1 from suite_keys_current) then
    raise exception 'suite_keys_current is empty — refusing to deprecate every suite_keys row; check today''s sync before retrying';
  end if;

  insert into suite_keys (suite_key)
  select sc.suite_key
  from suite_keys_current sc
  where not exists (
    select 1 from suite_keys sk where lower(sk.suite_key) = lower(sc.suite_key)
  );
  get diagnostics v_added = row_count;

  update suite_keys sk
  set deprecated_at = current_date
  where sk.deprecated_at is null
    and not exists (
      select 1 from suite_keys_current sc where lower(sc.suite_key) = lower(sk.suite_key)
    );
  get diagnostics v_deprecated = row_count;

  update suite_keys sk
  set deprecated_at = null
  where sk.deprecated_at is not null
    and exists (
      select 1 from suite_keys_current sc where lower(sc.suite_key) = lower(sk.suite_key)
    );
  get diagnostics v_undeprecated = row_count;

  return query select v_added, v_deprecated, v_undeprecated;
end;
$$;

revoke execute on function reconcile_suite_keys_from_current() from anon, authenticated;

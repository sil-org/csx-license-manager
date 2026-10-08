-- The live suite_keys_current table predates 50_suite_keys_current_staging.sql,
-- whose `create table if not exists` therefore never ran: its cost-center
-- column is named `description`, not `cost_center`. refresh_suite_keys_current()
-- and reconcile_suite_keys_from_current() both read/write `cost_center`, so the
-- daily Pipedream sync failed with "column sc.cost_center does not exist".
-- Rename to match the functions. Guarded so re-running is a no-op.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'suite_keys_current' and column_name = 'description'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'suite_keys_current' and column_name = 'cost_center'
  ) then
    alter table suite_keys_current rename column description to cost_center;
  end if;
end;
$$;

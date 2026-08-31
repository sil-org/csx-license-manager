-- Extends reconcile_suite_keys_from_current()'s empty-snapshot guard: a
-- non-empty but suspiciously small suite_keys_current (a partial/truncated
-- sync, or a test payload) has the exact same failure mode as an empty one
-- — most of suite_keys gets wrongly deprecated — just not caught by the
-- earlier "is it empty" check. Refuse to proceed if this run would
-- deprecate more than half of currently-active suite_keys in one go.
create or replace function reconcile_suite_keys_from_current()
returns table (added int, deprecated int, undeprecated int)
language plpgsql security definer as $$
declare
  v_added int;
  v_deprecated int;
  v_undeprecated int;
  v_would_deprecate int;
  v_active int;
begin
  if not exists (select 1 from suite_keys_current) then
    raise exception 'suite_keys_current is empty — refusing to deprecate every suite_keys row; check today''s sync before retrying';
  end if;

  select count(*) into v_active from suite_keys where deprecated_at is null;

  select count(*) into v_would_deprecate
  from suite_keys sk
  where sk.deprecated_at is null
    and not exists (
      select 1 from suite_keys_current sc where lower(sc.suite_key) = lower(sk.suite_key)
    );

  if v_active > 0 and v_would_deprecate::numeric / v_active > 0.5 then
    raise exception 'refusing to deprecate % of % currently-active suite_keys in one run — suite_keys_current looks like a partial or test snapshot, not a full sync; confirm it''s complete before retrying', v_would_deprecate, v_active;
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

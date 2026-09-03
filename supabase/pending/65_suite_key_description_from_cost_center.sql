-- Keeps suite_keys.description mirroring suite_keys_current.cost_center —
-- folded into reconcile_suite_keys_from_current() (51/55) so it happens
-- automatically as part of the existing daily sync, no separate step.
-- Previously description was purely admin-owned free text (see
-- 50_suite_keys_current_staging.sql's header comment); this supersedes that
-- — description is now always overwritten with whatever cost_center the
-- finance system reports that day, admin edits included. The one carve-out:
-- a null cost_center in that day's pull leaves the existing description
-- alone rather than blanking it out, since that's far more likely a gap in
-- that day's export than Finance actually clearing the cost center.
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

  insert into suite_keys (suite_key, description)
  select sc.suite_key, sc.cost_center
  from suite_keys_current sc
  where not exists (
    select 1 from suite_keys sk where lower(sk.suite_key) = lower(sc.suite_key)
  );
  get diagnostics v_added = row_count;

  update suite_keys sk
  set description = sc.cost_center
  from suite_keys_current sc
  where lower(sc.suite_key) = lower(sk.suite_key)
    and sc.cost_center is not null
    and sc.cost_center is distinct from sk.description;

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

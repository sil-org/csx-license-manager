-- Admin CSV importer for profiles.manager_email, fed by a weekly export of
-- the Workday-derived org-hierarchy Sheet (see README's My Team section) —
-- there's no live API pull, since a direct Workday integration isn't
-- currently available and Workday itself is being retired within a year.
-- Mirrors admin_import_subscriptions()'s shape: one result per input row,
-- a bad row never aborts the batch.
--
-- Also adds get_last_team_import(), a narrow security-definer read so the
-- My Team page can show "last imported on X" without granting non-admins
-- direct select on team_hierarchy_imports — same rationale as
-- get_report_emails/get_admin_emails elsewhere in this file.

create table if not exists team_hierarchy_imports (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  performed_by text not null,
  row_count    int not null
);

alter table team_hierarchy_imports enable row level security;

drop policy if exists "team_hierarchy_imports: admin read" on team_hierarchy_imports;
create policy "team_hierarchy_imports: admin read" on team_hierarchy_imports for select
  using (is_admin());

create or replace function admin_import_team_hierarchy(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_admin text := current_profile_email();
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_email text;
  v_manager_email text;
  v_ok_count int := 0;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_email := lower(trim(v_row->>'primary_email'));
      v_manager_email := nullif(trim(lower(v_row->>'manager_email')), '');

      if v_email = '' or v_email is null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', 'Missing primary_email', 'row', v_row);
        continue;
      end if;

      if not exists (select 1 from profiles where lower(primary_email) = v_email) then
        v_results := v_results || jsonb_build_object('ok', false, 'error', 'No profile on file: ' || v_email, 'row', v_row);
        continue;
      end if;

      update profiles set manager_email = v_manager_email where lower(primary_email) = v_email;

      v_ok_count := v_ok_count + 1;
      v_results := v_results || jsonb_build_object('ok', true, 'row', v_row);
    exception when others then
      v_results := v_results || jsonb_build_object('ok', false, 'error', sqlerrm, 'row', v_row);
    end;
  end loop;

  insert into team_hierarchy_imports (performed_by, row_count) values (v_admin, v_ok_count);

  return v_results;
end;
$$;

create or replace function get_last_team_import()
returns table(created_at timestamptz, row_count int)
language sql stable security definer as $$
  select created_at, row_count from team_hierarchy_imports order by created_at desc limit 1
$$;

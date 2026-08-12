-- Adds profiles.sco: a 3-letter org code from the same Workday-derived
-- hierarchy Sheet as manager_email (see 32_team_hierarchy_import.sql).
-- Not read anywhere in this app yet — captured now, alongside the data
-- that's already flowing through the weekly import, so it's on file for
-- whatever uses it later instead of a second import pass down the road.
-- Same "store it now, unused" precedent as profiles.department.

alter table profiles add column if not exists sco text;

create or replace function admin_import_team_hierarchy(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_admin text := current_profile_email();
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_email text;
  v_manager_email text;
  v_sco text;
  v_ok_count int := 0;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_email := lower(trim(v_row->>'primary_email'));
      v_manager_email := nullif(trim(lower(v_row->>'manager_email')), '');
      v_sco := nullif(trim(upper(v_row->>'sco')), '');

      if v_email = '' or v_email is null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', 'Missing primary_email', 'row', v_row);
        continue;
      end if;

      if v_sco is not null and v_sco !~ '^[A-Z]{3}$' then
        v_results := v_results || jsonb_build_object('ok', false, 'error', 'SCO must be exactly 3 letters: ' || v_sco, 'row', v_row);
        continue;
      end if;

      if not exists (select 1 from profiles where lower(primary_email) = v_email) then
        v_results := v_results || jsonb_build_object('ok', false, 'error', 'No profile on file: ' || v_email, 'row', v_row);
        continue;
      end if;

      update profiles set manager_email = v_manager_email, sco = v_sco where lower(primary_email) = v_email;

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

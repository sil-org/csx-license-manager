-- Run this in the Supabase SQL Editor. Adds profiles.employee_type and
-- profiles.staff_id, sourced from the same Workday-derived hierarchy Sheet
-- as manager_email/sco/job_title — threaded through
-- admin_import_team_hierarchy() (latest version:
-- pending/39_team_hierarchy_job_title.sql) exactly like job_title: free
-- text, no format validation, nullable until the source sheet has the
-- column populated.

alter table profiles add column if not exists employee_type text;
alter table profiles add column if not exists staff_id text;

create or replace function admin_import_team_hierarchy(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_admin text := current_profile_email();
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_email text;
  v_manager_email text;
  v_sco text;
  v_job_title text;
  v_employee_type text;
  v_staff_id text;
  v_ok_count int := 0;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_email := lower(trim(v_row->>'primary_email'));
      v_manager_email := nullif(trim(lower(v_row->>'manager_email')), '');
      v_sco := nullif(trim(upper(v_row->>'sco')), '');
      v_job_title := nullif(trim(v_row->>'job_title'), '');
      v_employee_type := nullif(trim(v_row->>'employee_type'), '');
      v_staff_id := nullif(trim(v_row->>'staff_id'), '');

      if v_email = '' or v_email is null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', 'Missing primary_email', 'row', v_row);
        continue;
      end if;

      if v_sco is not null and v_sco !~ '^[A-Z]{3}$' then
        v_results := v_results || jsonb_build_object('ok', false, 'error', 'SCO must be exactly 3 letters: ' || v_sco, 'row', v_row);
        continue;
      end if;

      if not exists (select 1 from profiles where lower(primary_email) = v_email) then
        if not is_eligible_staff_email(v_email) then
          v_results := v_results || jsonb_build_object('ok', false, 'error', 'Not an eligible staff email: ' || v_email, 'row', v_row);
          continue;
        end if;
        insert into profiles (display_name, primary_email) values (v_email, v_email);
      end if;

      update profiles set manager_email = v_manager_email, sco = v_sco, job_title = v_job_title,
        employee_type = v_employee_type, staff_id = v_staff_id
        where lower(primary_email) = v_email;

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

-- Run this in the Supabase SQL Editor. Fixes "canceling statement due to
-- statement timeout" on a real (thousands-of-rows) Team hierarchy import.
--
-- admin_import_team_hierarchy() built its per-row result list by repeatedly
-- concatenating onto a jsonb value: `v_results := v_results ||
-- jsonb_build_object(...)`. jsonb || jsonb reserializes the entire
-- (growing) array on every iteration, so the loop is O(n^2) in row count —
-- fine for a handful of test rows, but a full org roster is big enough to
-- blow through the statement timeout before the loop finishes.
--
-- Fix: accumulate into a native jsonb[] array instead. PL/pgSQL recognizes
-- the self-assignment `arr := arr || elem` on an actual array type and
-- appends in place (its "expanded array" optimization) rather than copying
-- the whole thing each time, so this is O(n). to_jsonb() at the very end
-- converts the jsonb[] into the same jsonb array shape callers already get
-- — no change to the return value, only how it's built.
--
-- Same O(n^2) jsonb-concat-in-a-loop pattern exists in the other importers
-- in this file (SCO codes, quick subscription import, the GAS backfill
-- importers) — not fixed here since none of those have actually hit the
-- timeout, but worth the same treatment if one ever does.

create or replace function admin_import_team_hierarchy(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_admin text := current_profile_email();
  v_row jsonb;
  v_results jsonb[] := '{}';
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

  return to_jsonb(v_results);
end;
$$;

-- Follow-up to 32_team_hierarchy_import.sql: "No profile on file" was the
-- failure on ~4114 rows of the real Workday-derived import — most staff
-- have never signed into this app, so their primary_email had no matching
-- profiles row yet. Same fix as 33_import_creates_requester_profile.sql's
-- placeholder-profile pattern for admin_import_subscriptions(), but this
-- one additionally gates on is_eligible_staff_email() before creating a
-- profile — the hierarchy export can include people this app should never
-- have a row for (external contractors/vendors, terminated staff still on
-- an old export, a shared/generic mailbox listed as someone's manager),
-- and a placeholder created here wouldn't go through the eligibility check
-- resolve_profile() enforces at real sign-in. Rows that fail eligibility
-- are reported back as failures with a clear reason, not silently skipped.
--
-- Note: 33_import_creates_requester_profile.sql's own placeholder-creation
-- path doesn't have this same eligibility gate — it wasn't wrong for that
-- narrower case (one historical requester at a time, already a known SIL
-- person), but worth being aware the two paths differ if it's ever revisited.

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
        if not is_eligible_staff_email(v_email) then
          v_results := v_results || jsonb_build_object('ok', false, 'error', 'Not an eligible staff email: ' || v_email, 'row', v_row);
          continue;
        end if;
        insert into profiles (display_name, primary_email) values (v_email, v_email);
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

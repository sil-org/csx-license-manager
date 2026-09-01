-- Run this in the Supabase SQL Editor. Adds a proper sco -> department-name
-- lookup table instead of the free-text profiles.department column, which
-- turned out to have no write path anywhere in the app (added early for
-- department-gated licensing, never actually wired into the team-hierarchy
-- import or any admin UI, so it was always null in practice). department_gated
-- licensing itself already keyed off the 3-letter `sco` code, not a
-- department name, so this doesn't touch that machinery — it only fixes what
-- get_seat_provisioning_fields() returns for the provisioning email's
-- Department row.
--
-- Sourced from Kate's org-structure Sheet (Zone / Area / OU / Code columns).
-- OU is the most granular level and is what "department name" means here —
-- Zone/Area are kept too since the Sheet has them and they're free to store,
-- but nothing reads them yet.

alter table profiles drop column if exists department;

create table if not exists sco_codes (
  code  text primary key check (code ~ '^[A-Z]{3}$'),
  ou    text not null,
  area  text,
  zone  text
);

alter table sco_codes enable row level security;
drop policy if exists "sco_codes: admin only" on sco_codes;
create policy "sco_codes: admin only" on sco_codes for all
  using (is_admin()) with check (is_admin());

-- ─── RPC: get_seat_provisioning_fields — department via sco_codes join ──────

create or replace function get_seat_provisioning_fields(p_email text)
returns table(display_name text, job_title text, department text)
language sql stable security definer as $$
  select p.display_name, p.job_title, sc.ou
  from profiles p
  left join sco_codes sc on sc.code = p.sco
  where lower(p.primary_email) = lower(p_email)
  limit 1
$$;

-- ─── RPC: admin_import_sco_codes ─────────────────────────────────────────────
-- Mirrors admin_import_team_hierarchy()'s shape: one result per input row, a
-- bad row never aborts the batch. Upsert-only, same as team hierarchy — a
-- code missing from this week's export just doesn't get touched, rather than
-- being deleted, since a stale-but-present row is safer than a request
-- suddenly resolving to no department at all.

create or replace function admin_import_sco_codes(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_code text;
  v_ou text;
  v_area text;
  v_zone text;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_code := nullif(trim(upper(v_row->>'code')), '');
      v_ou := nullif(trim(v_row->>'ou'), '');
      v_area := nullif(trim(v_row->>'area'), '');
      v_zone := nullif(trim(v_row->>'zone'), '');

      if v_code is null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', 'Missing code', 'row', v_row);
        continue;
      end if;
      if v_code !~ '^[A-Z]{3}$' then
        v_results := v_results || jsonb_build_object('ok', false, 'error', 'Code must be exactly 3 letters: ' || v_code, 'row', v_row);
        continue;
      end if;
      if v_ou is null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', 'Missing OU', 'row', v_row);
        continue;
      end if;

      insert into sco_codes (code, ou, area, zone) values (v_code, v_ou, v_area, v_zone)
      on conflict (code) do update set ou = excluded.ou, area = excluded.area, zone = excluded.zone;

      v_results := v_results || jsonb_build_object('ok', true, 'row', v_row);
    exception when others then
      v_results := v_results || jsonb_build_object('ok', false, 'error', sqlerrm, 'row', v_row);
    end;
  end loop;

  return v_results;
end;
$$;

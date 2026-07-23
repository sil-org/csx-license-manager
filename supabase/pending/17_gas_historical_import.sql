-- Run this in the Supabase SQL Editor. One-time historical backfill from the
-- GAS project's Licenses/Subscriptions/AuditLog sheets. Adds a nullable
-- legacy_id column to licenses/subscriptions/audit_log (unique when present)
-- so: (a) each import is safely re-runnable — a row already carrying its
-- legacy id is skipped rather than duplicated — and (b) admin_import_audit_log
-- can resolve each old AuditLog row's SubscriptionID to the real subscription
-- it belongs to.
--
-- Run the three importers in this order (each is its own RPC, driven from a
-- new Admin -> Import UI section): licenses, then subscriptions, then audit
-- log — subscriptions need licenses to exist first (matched by legacy id or
-- name), and audit log needs subscriptions to exist first (matched by legacy
-- id) for its subscription_id link to resolve.
--
-- None of these three touch anything already in the live tables: licenses
-- and subscriptions both skip a row if a matching one already exists (by
-- legacy_id, or by name / user+license+FY for a live, non-imported row), and
-- audit log is purely additive (append-only by nature).

alter table licenses add column if not exists legacy_id text;
create unique index if not exists licenses_legacy_id_idx on licenses (legacy_id) where legacy_id is not null;

alter table subscriptions add column if not exists legacy_id text;
create unique index if not exists subscriptions_legacy_id_idx on subscriptions (legacy_id) where legacy_id is not null;

alter table audit_log add column if not exists legacy_id text;
create unique index if not exists audit_log_legacy_id_idx on audit_log (legacy_id) where legacy_id is not null;

-- ─── RPC: admin_import_licenses ─────────────────────────────────────────────────
-- GAS's Licenses sheet, column-mapped 1:1 onto the new schema, with two
-- deliberate exceptions: (1) `activated` (GAS column 15) is dropped — it's
-- dead data, never read anywhere in gas-legacy/ beyond being persisted, and
-- has no equivalent column here; (2) `price_unit` is recomputed from
-- billing_cycle rather than copied from GAS's stored value, since GAS's own
-- data has price_unit stuck at "per seat/year" even for monthly-billed
-- licenses (the exact stale-text bug Admin -> Catalog's billing-cycle-driven
-- price unit was built to prevent — see Catalog.jsx's PRICE_UNITS map).

create or replace function admin_import_licenses(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_legacy_id text;
  v_name text;
  v_billing_cycle billing_cycle;
  v_created_by uuid;
  v_id uuid;
  v_error text;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_error := null;
      v_legacy_id := nullif(trim(v_row->>'legacy_id'), '');
      v_name := trim(v_row->>'name');

      if v_name = '' or v_name is null then
        v_error := 'Missing name';
      elsif exists (
        select 1 from licenses
        where (v_legacy_id is not null and legacy_id = v_legacy_id) or lower(name) = lower(v_name)
      ) then
        v_error := 'Already exists: ' || v_name;
      end if;

      if v_error is not null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', v_error, 'row', v_row);
        continue;
      end if;

      v_billing_cycle := coalesce(nullif(v_row->>'billing_cycle', ''), 'annual')::billing_cycle;

      v_created_by := null;
      if nullif(trim(v_row->>'created_by_email'), '') is not null then
        select id into v_created_by from profiles where lower(primary_email) = lower(trim(v_row->>'created_by_email'));
      end if;

      insert into licenses (
        legacy_id, name, vendor, category, price, price_unit, notes, active, gtis_sponsored,
        billing_cycle, renewal_month, renewal_reminder, created_by, logo_url, activation_url,
        more_info_url, google_group_email, pro_rated, service_manager_email
      ) values (
        v_legacy_id, v_name, nullif(trim(v_row->>'vendor'), ''), nullif(trim(v_row->>'category'), ''),
        nullif(v_row->>'price', '')::numeric,
        case v_billing_cycle when 'annual' then 'per seat/year' when 'monthly' then 'per seat/month' else 'one-time' end,
        nullif(v_row->>'notes', ''),
        coalesce((v_row->>'active')::boolean, true),
        coalesce((v_row->>'gtis_sponsored')::boolean, false),
        v_billing_cycle,
        nullif(v_row->>'renewal_month', '')::int,
        coalesce((v_row->>'renewal_reminder')::boolean, true),
        v_created_by,
        nullif(trim(v_row->>'logo_url'), ''), nullif(trim(v_row->>'activation_url'), ''),
        nullif(trim(v_row->>'more_info_url'), ''), nullif(trim(lower(v_row->>'google_group_email')), ''),
        coalesce((v_row->>'pro_rated')::boolean, false),
        nullif(trim(lower(v_row->>'service_manager_email')), '')
      ) returning id into v_id;

      v_results := v_results || jsonb_build_object('ok', true, 'id', v_id, 'row', v_row);
    exception when others then
      v_results := v_results || jsonb_build_object('ok', false, 'error', sqlerrm, 'row', v_row);
    end;
  end loop;

  return v_results;
end;
$$;

-- ─── RPC: admin_import_subscriptions_full ──────────────────────────────────────
-- Distinct from admin_import_subscriptions() above: that one is a quick
-- "just get currently-active seats in the door" tool that forces status =
-- 'active' and fabricates a single 'imported' audit row. This one preserves
-- the GAS row's real historical status/dates/billing fields verbatim, and
-- does NOT write any audit_log row itself — the real historical trail comes
-- in separately via admin_import_audit_log, and duplicating a synthetic
-- entry on top of it would just clutter that trail.
--
-- "Don't overwrite" is enforced two ways: skip if legacy_id already exists
-- (safe to re-run), and skip if a subscription for the same user+license+FY
-- already exists WITHOUT a legacy_id (i.e. real, live-created data — several
-- users have more than one historical row for the same license+FY, e.g.
-- revoke-then-re-request, so only a live/non-imported match blocks a row,
-- not another already-imported historical one).

create or replace function admin_import_subscriptions_full(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_legacy_id text;
  v_user_email text;
  v_license licenses%rowtype;
  v_raw_suite_key text;
  v_suite_key text;
  v_ministry_id text;
  v_canonical_key text;
  v_billing_type subscription_billing_type;
  v_start_date date;
  v_fy int;
  v_status subscription_status;
  v_renewal_status renewal_status;
  v_billing_cycle billing_cycle;
  v_renewal_month int;
  v_renewal_reminder boolean;
  v_price_at_signup numeric;
  v_sub_id uuid;
  v_error text;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_error := null;
      v_legacy_id := nullif(trim(v_row->>'legacy_id'), '');
      v_user_email := lower(trim(v_row->>'user_email'));
      v_license := null;
      v_suite_key := null;
      v_ministry_id := null;

      if v_legacy_id is not null and exists (select 1 from subscriptions where legacy_id = v_legacy_id) then
        v_error := 'Already imported: ' || v_legacy_id;
      end if;

      if v_error is null then
        select * into v_license from licenses
        where (nullif(v_row->>'license_legacy_id', '') is not null and legacy_id = v_row->>'license_legacy_id')
           or lower(name) = lower(trim(v_row->>'license_name'))
        limit 1;
        if v_license.id is null then
          v_error := 'License not found: ' || (v_row->>'license_name');
        end if;
      end if;

      if v_error is null then
        v_fy := (v_row->>'fy')::int;
        if exists (
          select 1 from subscriptions
          where user_email = v_user_email and license_id = v_license.id and fy = v_fy and legacy_id is null
        ) then
          v_error := 'Live subscription already exists for this user/license/FY';
        end if;
      end if;

      if v_error is null then
        v_raw_suite_key := regexp_replace(trim(coalesce(v_row->>'suite_key', '')), '~.*$', '');

        if v_raw_suite_key = 'GTIS' or (v_license.gtis_sponsored and v_raw_suite_key = '') then
          v_billing_type := 'gtis';
        elsif v_raw_suite_key ~* '^(MIN:)?\d{6}$' then
          v_ministry_id := regexp_replace(v_raw_suite_key, '^MIN:', '', 'i');
          v_billing_type := 'ministry';
        elsif v_raw_suite_key = '' then
          v_error := 'Missing SuiteKey/Ministry ID';
        else
          v_billing_type := 'suite_key';
          select suite_key into v_canonical_key from suite_keys where lower(suite_key) = lower(v_raw_suite_key);
          v_suite_key := coalesce(v_canonical_key, v_raw_suite_key);
          if v_canonical_key is null then
            insert into suite_keys (suite_key, owner_email) values (v_suite_key, null);
          end if;
        end if;
      end if;

      if v_error is not null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', v_error, 'row', v_row);
        continue;
      end if;

      v_start_date := to_date(split_part(v_row->>'start_date', ' ', 1), 'FMMM/FMDD/YYYY');
      v_status := (v_row->>'status')::subscription_status;
      v_renewal_status := coalesce(nullif(v_row->>'renewal_status', '')::renewal_status, 'none');
      v_billing_cycle := coalesce(nullif(v_row->>'billing_cycle', '')::billing_cycle, v_license.billing_cycle);
      v_renewal_month := coalesce(nullif(v_row->>'renewal_month', '')::int, v_license.renewal_month);
      v_renewal_reminder := coalesce(nullif(v_row->>'renewal_reminder', '')::boolean, v_license.renewal_reminder);
      v_price_at_signup := nullif(v_row->>'price_at_signup', '')::numeric;

      -- Must precede the subscriptions insert below — subscriptions.ministry_id
      -- has an FK into ministry_ids(ministry_id), so the row has to exist first.
      if v_ministry_id is not null then
        insert into ministry_ids (email, ministry_id) values (v_user_email, v_ministry_id)
          on conflict (email) do update set ministry_id = excluded.ministry_id;
      end if;

      insert into subscriptions (
        legacy_id, user_email, license_id, suite_key, billing_type, ministry_id, start_date, fy, status,
        renewal_status, billing_cycle, renewal_month, renewal_reminder, price_at_signup
      ) values (
        v_legacy_id, v_user_email, v_license.id, v_suite_key, v_billing_type, v_ministry_id, v_start_date, v_fy, v_status,
        v_renewal_status, v_billing_cycle, v_renewal_month, v_renewal_reminder, v_price_at_signup
      ) returning id into v_sub_id;

      v_results := v_results || jsonb_build_object('ok', true, 'id', v_sub_id, 'row', v_row);
    exception when others then
      v_results := v_results || jsonb_build_object('ok', false, 'error', sqlerrm, 'row', v_row);
    end;
  end loop;

  return v_results;
end;
$$;

-- ─── RPC: admin_import_audit_log ───────────────────────────────────────────────
-- Purely additive — every historical action GAS ever logged maps directly
-- onto the existing audit_action enum, no remapping needed. subscription_id
-- resolves via the legacy_id stamped by admin_import_subscriptions_full
-- above; if it can't resolve (e.g. that importer hasn't been run, or this
-- row's subscription genuinely isn't in the export), the row still imports
-- with a null subscription_id and the legacy id preserved in notes instead
-- of being silently dropped.

create or replace function admin_import_audit_log(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_legacy_id text;
  v_sub_legacy_id text;
  v_sub_id uuid;
  v_notes text;
  v_error text;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_error := null;
      v_legacy_id := nullif(trim(v_row->>'legacy_id'), '');

      if v_legacy_id is not null and exists (select 1 from audit_log where legacy_id = v_legacy_id) then
        v_error := 'Already imported: ' || v_legacy_id;
      end if;

      if v_error is not null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', v_error, 'row', v_row);
        continue;
      end if;

      v_sub_legacy_id := nullif(trim(v_row->>'subscription_legacy_id'), '');
      v_sub_id := null;
      v_notes := nullif(v_row->>'notes', '');
      if v_sub_legacy_id is not null then
        select id into v_sub_id from subscriptions where legacy_id = v_sub_legacy_id;
        if v_sub_id is null then
          v_notes := '[legacy ' || v_sub_legacy_id || '] ' || coalesce(v_notes, '');
        end if;
      end if;

      insert into audit_log (
        legacy_id, created_at, action, subscription_id, license_name, user_email, suite_key, performed_by, notes
      ) values (
        v_legacy_id,
        to_timestamp(v_row->>'timestamp', 'FMMM/FMDD/YYYY FMHH24:MI:SS'),
        (v_row->>'action')::audit_action,
        v_sub_id, nullif(v_row->>'license_name', ''), lower(trim(v_row->>'user_email')),
        nullif(v_row->>'suite_key', ''), lower(trim(v_row->>'performed_by')), v_notes
      );

      v_results := v_results || jsonb_build_object('ok', true, 'row', v_row);
    exception when others then
      v_results := v_results || jsonb_build_object('ok', false, 'error', sqlerrm, 'row', v_row);
    end;
  end loop;

  return v_results;
end;
$$;

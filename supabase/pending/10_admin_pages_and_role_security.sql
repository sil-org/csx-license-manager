-- Run this in the Supabase SQL Editor. Adds everything behind the four new
-- Admin tabs (All Subscriptions, Finance Export, Import, Admin Users) plus a
-- real security fix found while building the last one.
--
-- SECURITY FIX FIRST — nothing previously stopped a signed-in user from
-- self-promoting to admin via a plain client-side call like
-- supabase.from('profiles').update({role: 'admin'}).eq('id', myProfileId) —
-- the "profiles: own update" RLS policy let you update your own row with no
-- restriction on which columns. This adds a with check that blocks changing
-- role through that path; role changes now only happen through
-- admin_set_role() below, which bypasses RLS as the table owner. This same
-- fix should be applied to the shared sil-app-template / Helpdesk copy of
-- schema.sql too, since the vulnerability is in the template itself.

drop policy if exists "profiles: own update" on profiles;
create policy "profiles: own update"
  on profiles for update
  using (id = current_profile_id())
  with check (id = current_profile_id() and role = get_profile_role());

-- ─── RPC: calc_prorated_cost / get_finance_export ──────────────────────────────
-- Ported from gas-legacy/src/Catalog.gs's _calcProRatedCost()/getFinanceExport().
-- Pro-rating only applies when licenses.pro_rated is set — everything else
-- charges the flat license price regardless of when in the cycle it started.
--   - Monthly: day-based — days remaining in the start month (inclusive of
--     the start day) as a fraction of days in that month.
--   - Annual (default): month-based — months remaining from the start date
--     to the next occurrence of the license's renewal_month (1-12), defaulting
--     to October (SIL's FY start) if unset.
-- Not security definer — relies on the caller's own RLS read access (admins
-- can already read every subscriptions/licenses row via existing policies;
-- this just adds the math on top).

create or replace function calc_prorated_cost(
  p_price numeric, p_billing_cycle billing_cycle, p_renewal_month int, p_pro_rated boolean, p_start_date date
) returns numeric language plpgsql immutable as $$
declare
  v_day int;
  v_days_in_month int;
  v_days_left int;
  v_renew_month int;
  v_start_month int;
  v_months int;
begin
  if not p_pro_rated then
    return p_price;
  end if;

  if p_billing_cycle = 'monthly' then
    v_day := extract(day from p_start_date)::int;
    v_days_in_month := extract(day from (date_trunc('month', p_start_date) + interval '1 month - 1 day'))::int;
    v_days_left := v_days_in_month - v_day + 1;
    return round(p_price * v_days_left / v_days_in_month, 2);
  end if;

  v_renew_month := coalesce(nullif(p_renewal_month, 0), 10);
  v_start_month := extract(month from p_start_date)::int;
  v_months := v_renew_month - v_start_month;
  if v_months <= 0 then
    v_months := v_months + 12;
  end if;
  return round(p_price * v_months / 12, 2);
end;
$$;

create or replace function get_finance_export(p_start_date date, p_end_date date)
returns table(
  user_email text, license_name text, billing_label text, cost numeric, start_date date, status text
) language sql stable as $$
  select
    s.user_email,
    l.name,
    case
      when s.billing_type = 'gtis' then 'GTIS'
      when s.billing_type = 'ministry' then 'Ministry ID ' || s.ministry_id
      else s.suite_key
    end,
    calc_prorated_cost(l.price, l.billing_cycle, l.renewal_month, l.pro_rated, s.start_date),
    s.start_date,
    s.status::text
  from subscriptions s
  join licenses l on l.id = s.license_id
  where s.status in ('active', 'approved')
    and s.start_date >= p_start_date
    and s.start_date <= p_end_date
  order by s.start_date;
$$;

-- ─── RPC: admin_import_subscriptions ────────────────────────────────────────────
-- Ported from gas-legacy/src/Catalog.gs's importSubscriptions(). Bulk-creates
-- already-active subscriptions from a legacy/historical source — no approval
-- emails, no SK verification step, no Google Group changes. Skips rows where
-- the user already has a non-cancelled/declined/revoked subscription for the
-- same license+FY (mirrors request_subscription()'s own duplicate check).
--
-- p_rows is a JSON array of {user_email, license_name, suite_key, start_date,
-- fy}: suite_key accepts a real SuiteKey, a 6-digit Ministry ID (bare or
-- "MIN:XXXXXX"), or blank for a GTIS-sponsored license. Applies the same
-- SuiteKey trim/tilde-block/case-insensitive-match rules as
-- request_subscription(), for the same reasons — and the same FY rollover
-- rule as GAS's getCurrentFiscalYear() when fy isn't given (October start).
--
-- Each row is processed in its own sub-block so one bad row can't abort the
-- whole batch — returns one result object per input row: {ok, error?, row}.
-- NOT ported: GAS's ALLOWED_DOMAINS allowlist (a specific list of SIL-
-- affiliated external domains) — add it back here if bulk imports need it.

create or replace function admin_import_subscriptions(p_rows jsonb)
returns jsonb language plpgsql security definer as $$
declare
  v_admin text := current_profile_email();
  v_row jsonb;
  v_results jsonb := '[]'::jsonb;
  v_user_email text;
  v_license_name text;
  v_raw_suite_key text;
  v_start_date date;
  v_fy int;
  v_license licenses%rowtype;
  v_billing_type subscription_billing_type;
  v_suite_key text;
  v_ministry_id text;
  v_canonical_key text;
  v_sub_id uuid;
  v_error text;
begin
  if not is_admin() then raise exception 'admin only'; end if;

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    begin
      v_error := null;
      v_user_email := lower(trim(v_row->>'user_email'));
      v_license_name := trim(v_row->>'license_name');
      v_raw_suite_key := trim(coalesce(v_row->>'suite_key', ''));
      v_billing_type := null;
      v_suite_key := null;
      v_ministry_id := null;
      v_license := null;

      if v_user_email = '' or v_user_email is null then
        v_error := 'Missing email';
      elsif v_user_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
        v_error := 'Invalid email';
      elsif v_license_name = '' or v_license_name is null then
        v_error := 'Missing license name';
      end if;

      if v_error is null then
        select * into v_license from licenses where lower(name) = lower(v_license_name) and active;
        if v_license.id is null then
          v_error := 'License not found in catalog: ' || v_license_name;
        end if;
      end if;

      if v_error is null then
        v_start_date := nullif(v_row->>'start_date', '')::date;
        if v_start_date is null then v_start_date := current_date; end if;

        if v_row->>'fy' is not null and (v_row->>'fy') != '' then
          v_fy := (v_row->>'fy')::int;
        else
          v_fy := extract(year from v_start_date)::int + (case when extract(month from v_start_date) >= 10 then 1 else 0 end);
        end if;

        if v_license.gtis_sponsored and v_raw_suite_key = '' then
          v_billing_type := 'gtis';
        elsif v_raw_suite_key ~ '^\d{6}$' or v_raw_suite_key ~* '^MIN:\d{6}$' then
          v_ministry_id := regexp_replace(v_raw_suite_key, '^MIN:', '', 'i');
          v_billing_type := 'ministry';
        elsif v_raw_suite_key = '' then
          v_error := 'Missing SuiteKey or Ministry ID';
        else
          v_billing_type := 'suite_key';
          if v_raw_suite_key like '%~%' then
            v_error := 'SuiteKey cannot contain "~"';
          else
            select suite_key into v_canonical_key from suite_keys where lower(suite_key) = lower(v_raw_suite_key);
            v_suite_key := coalesce(v_canonical_key, v_raw_suite_key);
            if v_canonical_key is null then
              insert into suite_keys (suite_key, owner_email) values (v_suite_key, null);
            end if;
          end if;
        end if;
      end if;

      if v_error is null and exists (
        select 1 from subscriptions
        where user_email = v_user_email and license_id = v_license.id and fy = v_fy
          and status not in ('declined', 'revoked', 'cancelled')
      ) then
        v_error := 'Already has a subscription for FY' || v_fy;
      end if;

      if v_error is not null then
        v_results := v_results || jsonb_build_object('ok', false, 'error', v_error, 'row', v_row);
        continue;
      end if;

      insert into subscriptions (
        user_email, license_id, suite_key, billing_type, ministry_id, fy, status,
        billing_cycle, renewal_month, renewal_reminder, price_at_signup, requested_by
      ) values (
        v_user_email, v_license.id, v_suite_key, v_billing_type, v_ministry_id, v_fy, 'active',
        v_license.billing_cycle, v_license.renewal_month, v_license.renewal_reminder, v_license.price, current_profile_id()
      ) returning id into v_sub_id;

      if v_ministry_id is not null then
        insert into ministry_ids (email, ministry_id) values (v_user_email, v_ministry_id)
          on conflict (email) do update set ministry_id = excluded.ministry_id;
      end if;

      insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes)
      values (
        'imported', v_sub_id, v_license.name, v_user_email,
        case when v_billing_type = 'gtis' then 'GTIS' when v_billing_type = 'ministry' then 'MIN:' || v_ministry_id else v_suite_key end,
        v_admin, 'imported from legacy system'
      );

      v_results := v_results || jsonb_build_object('ok', true, 'id', v_sub_id, 'row', v_row);
    exception when others then
      v_results := v_results || jsonb_build_object('ok', false, 'error', sqlerrm, 'row', v_row);
    end;
  end loop;

  return v_results;
end;
$$;

-- ─── RPC: admin_set_role ────────────────────────────────────────────────────────
-- The only sanctioned way a profile's role can change now — see the RLS fix
-- above. Refuses to demote the last remaining admin, so the app can never
-- end up with zero admins and nobody able to fix it without raw SQL.

create or replace function admin_set_role(p_profile_id uuid, p_role user_role)
returns void language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;

  if p_role = 'member' and (select role from profiles where id = p_profile_id) = 'admin' then
    if (select count(*) from profiles where role = 'admin') <= 1 then
      raise exception 'cannot demote the last remaining admin';
    end if;
  end if;

  update profiles set role = p_role where id = p_profile_id;
end;
$$;

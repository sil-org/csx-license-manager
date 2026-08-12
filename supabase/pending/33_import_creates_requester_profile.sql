-- Follow-up to #4 (32_import_requester_column.sql): that migration made
-- admin_import_subscriptions()'s requester_email error out ("Requester not
-- found") on anyone who hasn't signed into the app yet. That's the common
-- case for historical data, so this creates a placeholder profile for them
-- instead (display_name = the email itself, same fallback auth.js already
-- uses when a Google account has no full name on file).
--
-- Run supabase/schema.sql AGAIN first (it's idempotent) — it now defines a
-- fixed resolve_profile() that links a placeholder profile to the person's
-- real Google account on their actual first sign-in instead of trying to
-- insert a second profiles row (would violate the unique, case-insensitive
-- primary_email index) and erroring their whole first login. schema.sql is
-- shared with the helpdesk app's repo — copy the updated file over there
-- too so the two stay in sync (they share the same Supabase project, so
-- whichever copy of resolve_profile() ran last wins).

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
  v_requester_email text;
  v_requested_by uuid;
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
      -- Anything from "~" onward is stray pasted text, not part of the real
      -- key (e.g. "Relations-U_SIL~5407") — ignore it rather than rejecting
      -- the row, same as admin_import_subscriptions_full() already does.
      v_raw_suite_key := regexp_replace(trim(coalesce(v_row->>'suite_key', '')), '~.*$', '');
      v_billing_type := null;
      v_suite_key := null;
      v_ministry_id := null;
      v_license := null;
      v_requested_by := current_profile_id();

      if v_user_email = '' or v_user_email is null then
        v_error := 'Missing email';
      elsif v_user_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
        v_error := 'Invalid email';
      elsif v_license_name = '' or v_license_name is null then
        v_error := 'Missing license name';
      end if;

      v_requester_email := nullif(trim(lower(v_row->>'requester_email')), '');
      if v_error is null and v_requester_email is not null then
        select id into v_requested_by from profiles where lower(primary_email) = v_requester_email;
        if v_requested_by is null then
          insert into profiles (display_name, primary_email) values (v_requester_email, v_requester_email)
            returning id into v_requested_by;
        end if;
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
          select suite_key into v_canonical_key from suite_keys where lower(suite_key) = lower(v_raw_suite_key);
          v_suite_key := coalesce(v_canonical_key, v_raw_suite_key);
          if v_canonical_key is null then
            insert into suite_keys (suite_key, owner_email) values (v_suite_key, null);
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
        user_email, license_id, suite_key, billing_type, ministry_id, fy, status, activated_at,
        billing_cycle, renewal_month, renewal_reminder, price_at_signup, requested_by
      ) values (
        v_user_email, v_license.id, v_suite_key, v_billing_type, v_ministry_id, v_fy, 'active', v_start_date,
        v_license.billing_cycle, v_license.renewal_month, v_license.renewal_reminder, v_license.price, v_requested_by
      ) returning id into v_sub_id;

      if v_ministry_id is not null then
        insert into ministry_ids (email, ministry_id) values (v_user_email, v_ministry_id)
          on conflict (email) do update set ministry_id = excluded.ministry_id;
      end if;

      insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
      values (
        'imported', v_sub_id, v_license.name, v_user_email,
        case when v_billing_type = 'gtis' then 'GTIS' when v_billing_type = 'ministry' then 'MIN:' || v_ministry_id else v_suite_key end,
        v_admin, 'imported from legacy system', current_client_ip()
      );

      v_results := v_results || jsonb_build_object('ok', true, 'id', v_sub_id, 'row', v_row);
    exception when others then
      v_results := v_results || jsonb_build_object('ok', false, 'error', sqlerrm, 'row', v_row);
    end;
  end loop;

  return v_results;
end;
$$;

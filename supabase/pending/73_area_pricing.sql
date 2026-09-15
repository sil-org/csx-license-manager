-- Wires up the area-hierarchy stub from 60_sco_codes.sql (its own header
-- comment said "nothing reads them yet") into actual pricing. suite_keys_current
-- already carries a per-suite-key ou_code (50_suite_keys_current_staging.sql)
-- but it's never propagated anywhere; ou_code is the same 3-letter sco code
-- used elsewhere (profiles.sco, department_approvals.sco, sco_codes.code),
-- not a free-text OU name, so the join is suite_keys.ou_code = sco_codes.code
-- -> sco_codes.area.
--
-- Mirrors ou_code from suite_keys_current onto the durable suite_keys table
-- (same pattern as description <- cost_center below) because
-- suite_keys_current is truncated and fully reloaded every day by the
-- Pipedream sync — pricing needs to resolve area at any time, not just on
-- sync day.

alter table suite_keys add column if not exists ou_code text;

create table if not exists area_discounts (
  id                uuid primary key default gen_random_uuid(),
  license_id        uuid not null references licenses(id),
  area              text not null,
  discount_percent  numeric not null check (discount_percent > 0 and discount_percent <= 100),
  created_at        timestamptz not null default now(),
  unique (license_id, area)
);

alter table area_discounts enable row level security;
drop policy if exists "area_discounts: admin only" on area_discounts;
create policy "area_discounts: admin only" on area_discounts for all
  using (is_admin()) with check (is_admin());

-- ─── reconcile_suite_keys_from_current — also mirror ou_code ────────────────
-- Full-body rewrite (same convention as save_license()'s always-from-scratch
-- rebuild) rather than a bare ALTER, since the update statement it extends
-- lives inside this function's body.

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

  insert into suite_keys (suite_key, description, ou_code)
  select sc.suite_key, sc.cost_center, sc.ou_code
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

  -- Same null-carve-out as description above: a null ou_code in a day's pull
  -- leaves the existing value alone rather than blanking a resolvable area.
  update suite_keys sk
  set ou_code = sc.ou_code
  from suite_keys_current sc
  where lower(sc.suite_key) = lower(sk.suite_key)
    and sc.ou_code is not null
    and sc.ou_code is distinct from sk.ou_code;

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

-- ─── get_area_discounted_price — shared by request_subscription() and ──────
-- start_renewal_period(). Safe to call unconditionally: falls back to full
-- catalog price whenever the suite key, its ou_code, the sco_codes join, or
-- an area_discounts row is missing.

create or replace function get_area_discounted_price(p_license_id uuid, p_suite_key text)
returns numeric language sql stable as $$
  select l.price * (1 - coalesce(ad.discount_percent, 0) / 100.0)
  from licenses l
  left join suite_keys sk on lower(sk.suite_key) = lower(p_suite_key)
  left join sco_codes sc on sc.code = sk.ou_code
  left join area_discounts ad on ad.license_id = l.id and ad.area = sc.area
  where l.id = p_license_id
$$;

-- ─── request_subscription — apply area discount in the suite_key branch ────
-- Full-body rewrite, same convention as save_license(). Only the price_at_signup
-- value changes (v_license.price -> v_price_at_signup, set from
-- get_area_discounted_price() once a real suite key is resolved); every other
-- line is unchanged from the current schema_licenses.sql definition.

create or replace function request_subscription(
  p_license_id uuid,
  p_suite_key text,
  p_suggested_approver_email text,
  p_ministry_id text,
  p_fy int,
  p_recipient_email text default null,
  p_acknowledged boolean default false,
  p_extra_field_value text default null,
  p_suggested_approver_is_group boolean default false
) returns uuid language plpgsql security definer as $$
declare
  v_license licenses%rowtype;
  v_actor_email text := current_profile_email();
  v_recipient_email text := coalesce(nullif(trim(lower(p_recipient_email)), ''), current_profile_email());
  v_sub_id uuid;
  v_status subscription_status;
  v_billing_type subscription_billing_type;
  v_suite_key text := null;
  v_ministry_id text := null;
  v_audit_suite_key text;
  v_canonical_key text;
  v_owner text;
  v_owner_group text;
  v_pending_approver text := null;
  v_is_group boolean := false;
  v_sco text;
  v_price_at_signup numeric;
begin
  if v_actor_email is null then raise exception 'not authenticated'; end if;
  if not is_eligible_staff_email(v_recipient_email) then
    raise exception 'License requests are only available to SIL staff.';
  end if;

  select * into v_license from licenses where id = p_license_id and active;
  if v_license.id is null then raise exception 'license not found or inactive'; end if;
  v_price_at_signup := v_license.price;

  if v_license.requires_acknowledgement and not coalesce(p_acknowledged, false) then
    raise exception 'you must acknowledge the terms & conditions for this license before requesting it';
  end if;

  if v_license.extra_field_required and nullif(trim(p_extra_field_value), '') is null then
    raise exception '% is required for this license', coalesce(v_license.extra_field_label, 'this field');
  end if;

  if not v_license.allow_multiple_per_person and exists (
    select 1 from subscriptions
    where user_email = v_recipient_email and license_id = p_license_id and fy = p_fy
      and status not in ('declined', 'revoked', 'cancelled')
  ) then
    raise exception 'a subscription for this license already exists for this fiscal year';
  end if;

  if v_license.gtis_sponsored then
    v_billing_type := 'gtis';
    v_audit_suite_key := 'GTIS';
    v_status := 'approved';

  elsif v_license.department_gated then
    v_billing_type := 'department';
    select sco into v_sco from profiles where lower(primary_email) = v_recipient_email;
    if v_sco is not null then
      select approver_email into v_pending_approver
      from department_approvals where license_id = p_license_id and sco = v_sco;
    end if;
    v_audit_suite_key := 'DEPT:' || coalesce(v_sco, 'none');
    if v_pending_approver is not null then
      v_status := 'pending';
    else
      v_pending_approver := null;
      v_status := 'approved';
    end if;

  elsif p_ministry_id is not null then
    if p_ministry_id !~ '^\d{6}$' then
      raise exception 'ministry ID must be exactly 6 digits';
    end if;
    v_billing_type := 'ministry';
    v_ministry_id := p_ministry_id;
    v_audit_suite_key := 'MIN:' || p_ministry_id;
    insert into ministry_ids (email, ministry_id) values (v_recipient_email, p_ministry_id)
      on conflict (email) do update set ministry_id = excluded.ministry_id;
    v_status := 'approved';

  else
    v_billing_type := 'suite_key';
    if p_suite_key is null then raise exception 'a suite key is required'; end if;
    v_suite_key := regexp_replace(trim(p_suite_key), '~.*$', '');
    if v_suite_key = '' then raise exception 'a suite key is required'; end if;

    select suite_key, owner_email, owner_group_email into v_canonical_key, v_owner, v_owner_group
    from suite_keys where lower(suite_key) = lower(v_suite_key);
    if v_canonical_key is not null then
      v_suite_key := v_canonical_key;
    end if;
    v_audit_suite_key := v_suite_key;

    if v_canonical_key is null then
      insert into suite_keys (suite_key, owner_email) values (v_suite_key, null);
      v_owner := null;
      v_owner_group := null;
    end if;

    v_price_at_signup := get_area_discounted_price(p_license_id, v_suite_key);

    if v_owner_group is not null then
      if exists (
        select 1 from group_memberships where group_email = v_owner_group and lower(member_email) = lower(v_actor_email)
      ) then
        v_status := 'approved';
      else
        v_status := 'pending';
      end if;

    elsif v_owner is null then
      if p_suggested_approver_email is null then
        raise exception 'suite key % has no owner on file — provide a suggested approver email', v_suite_key;
      end if;
      v_pending_approver := nullif(lower(trim(p_suggested_approver_email)), '');
      if v_pending_approver = lower(v_actor_email) then
        update suite_keys set owner_email = lower(v_actor_email) where suite_key = v_suite_key;
        insert into audit_log (action, suite_key, performed_by, ip_address)
        values ('sk_verified', v_suite_key, v_actor_email, current_client_ip());
        v_status := 'approved';
        v_pending_approver := null;
      else
        v_status := 'pending_sk_verification';
        v_is_group := coalesce(p_suggested_approver_is_group, false);
      end if;
    elsif lower(v_owner) = lower(v_actor_email) then
      v_status := 'approved';
    else
      v_status := 'pending';
    end if;
  end if;

  insert into subscriptions (
    user_email, license_id, suite_key, billing_type, ministry_id, fy, status, billing_cycle,
    renewal_month, renewal_reminder, price_at_signup, pending_approver_email, pending_approver_is_group, requested_by, extra_field_value
  ) values (
    v_recipient_email, p_license_id, v_suite_key, v_billing_type, v_ministry_id, p_fy, v_status, v_license.billing_cycle,
    v_license.renewal_month, v_license.renewal_reminder, v_price_at_signup, v_pending_approver, v_is_group, current_profile_id(),
    nullif(trim(p_extra_field_value), '')
  ) returning id into v_sub_id;

  insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, notes, ip_address)
  values (
    'requested', v_sub_id, v_license.name, v_recipient_email, v_audit_suite_key, v_actor_email,
    nullif(trim(concat_ws(
      '; ',
      case when v_recipient_email <> v_actor_email then 'on behalf of ' || v_recipient_email else null end,
      case when v_license.requires_acknowledgement then 'acknowledged terms & conditions' else null end
    )), ''),
    current_client_ip()
  );

  if v_status = 'approved' then
    insert into audit_log (action, subscription_id, license_name, user_email, suite_key, performed_by, ip_address)
    values ('auto_approved', v_sub_id, v_license.name, v_recipient_email, v_audit_suite_key, v_actor_email, current_client_ip());
  end if;

  return v_sub_id;
end;
$$;

-- ─── start_renewal_period — apply area discount to renewal_price ───────────
-- Full-body rewrite, same convention. Only l.price -> get_area_discounted_price(l.id, o.suite_key)
-- changes; falls back to l.price for gtis/ministry/department rows since
-- o.suite_key is null there.

drop function if exists start_renewal_period(uuid, int);

create or replace function start_renewal_period(p_license_id uuid, p_fiscal_year int)
returns table(
  subscription_id uuid, user_email text, license_name text, billing_label text,
  renewal_price numeric, renewal_month int, reminder_message text
) language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;

  return query
  with opened as (
    update subscriptions s set open_renewal_fy = p_fiscal_year
    where s.license_id = p_license_id
      and s.status = 'active'
      and s.billing_cycle = 'annual'
      and s.renewal_reminder = true
      and s.billing_type != 'gtis'
      and s.open_renewal_fy is null
      and s.fy < p_fiscal_year
      and not exists (
        select 1 from renewals r where r.subscription_id = s.id and r.fiscal_year = p_fiscal_year
      )
    returning s.id, s.user_email, s.suite_key, s.ministry_id, s.billing_type,
      s.renewal_month, s.license_id
  ), logged as (
    insert into renewals (subscription_id, fiscal_year, reminder_sent_at, decision)
    select o.id, p_fiscal_year, now(), 'none' from opened o
    returning renewals.subscription_id
  )
  select
    o.id, o.user_email, l.name,
    case
      when o.billing_type = 'gtis' then 'GTIS'
      when o.billing_type = 'ministry' then 'Ministry ID ' || o.ministry_id
      else o.suite_key
    end,
    get_area_discounted_price(l.id, o.suite_key), o.renewal_month, l.reminder_message
  from opened o
  join licenses l on l.id = o.license_id;
end;
$$;

-- ─── admin CRUD for area_discounts ──────────────────────────────────────────
-- Table RLS is already admin-only; these are thin wrappers for the admin UI,
-- same rationale as admin_list/add/remove_department_approval.

create or replace function admin_list_area_discounts(p_license_id uuid)
returns table(id uuid, area text, discount_percent numeric)
language sql stable security definer as $$
  select id, area, discount_percent from area_discounts
  where license_id = p_license_id order by area
$$;

create or replace function admin_add_area_discount(p_license_id uuid, p_area text, p_discount_percent numeric)
returns uuid language plpgsql security definer as $$
declare v_id uuid;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  insert into area_discounts (license_id, area, discount_percent)
  values (p_license_id, trim(p_area), p_discount_percent)
  on conflict (license_id, area) do update set discount_percent = excluded.discount_percent
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function admin_remove_area_discount(p_id uuid)
returns void language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  delete from area_discounts where id = p_id;
end;
$$;

-- Distinct known areas, for a dropdown in the admin UI instead of free-typed
-- text — a typo'd area name would otherwise silently never match in
-- get_area_discounted_price() and the discount would just never apply.
create or replace function admin_list_areas()
returns table(area text)
language sql stable security definer as $$
  select distinct area from sco_codes where area is not null order by area
$$;

-- Free-text admin annotation on a single subscription (e.g. "waiting on
-- vendor invoice", "seat shared with contractor X") — distinct from
-- licenses.notes, which is a catalog-level note about the license itself,
-- not any one subscription. Surfaced in the finance export so finance can
-- see context without cross-referencing Admin -> All Subscriptions.

alter table subscriptions add column if not exists notes text;

-- ─── RPC: update_subscription_notes ────────────────────────────────────────────
-- Same authority as cancel_subscription()'s admin-or-service-manager check,
-- minus the self-service branch: a note is an internal annotation for
-- whoever administers the license, not something the subscriber sets on
-- their own request.

create or replace function update_subscription_notes(p_subscription_id uuid, p_notes text)
returns void language plpgsql security definer as $$
declare
  v_sub subscriptions%rowtype;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if not (is_admin() or is_service_manager_for(v_sub.license_id)) then
    raise exception 'not authorized to edit notes on this subscription';
  end if;

  update subscriptions set notes = nullif(trim(p_notes), '') where id = p_subscription_id;
end;
$$;

-- ─── RPC: get_finance_export — add notes ────────────────────────────────────
-- Adds a new OUT column, so Postgres won't let create-or-replace alter the
-- existing return type in place — drop it first.
drop function if exists get_finance_export(date, date);

create function get_finance_export(p_start_date date, p_end_date date)
returns table(
  user_email text, license_name text, billing_label text, cost numeric, price_paid numeric,
  start_date date, renewed_date date, status text, notes text
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
    s.price_at_signup,
    s.start_date,
    (select max(r.opt_in_date) from renewals r where r.subscription_id = s.id),
    s.status::text,
    s.notes
  from subscriptions s
  join licenses l on l.id = s.license_id
  where s.status = 'active'
     or (s.status = 'approved' and s.start_date >= p_start_date and s.start_date <= p_end_date)
  order by s.start_date;
$$;

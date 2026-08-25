-- Widens the per-subscription notes feature (45_subscription_notes.sql) into
-- a small "purchase details" set — product_key and invoice_number, both
-- plain text, alongside the existing notes and price_at_signup ("cost at
-- time of purchase") — all four now edited together from one modal in Admin
-- -> All Subscriptions instead of an inline notes-only textarea. Supersedes
-- update_subscription_notes() with a single RPC covering all four fields, so
-- the modal's one Save button makes one call.

alter table subscriptions add column if not exists product_key text;
alter table subscriptions add column if not exists invoice_number text;

drop function if exists update_subscription_notes(uuid, text);

-- ─── RPC: update_subscription_details ──────────────────────────────────────────
-- Same authority as cancel_subscription()'s admin-or-service-manager check,
-- minus the self-service branch: these are internal annotations for whoever
-- administers the license, not something the subscriber sets on their own
-- request. p_price_paid directly overwrites price_at_signup (unlike
-- activate_subscription()'s p_price, which only fills it in if not already
-- set) — this is an explicit edit action, not a "don't clobber what's
-- already there" one.

create or replace function update_subscription_details(
  p_subscription_id uuid, p_notes text, p_product_key text, p_invoice_number text, p_price_paid numeric
) returns void language plpgsql security definer as $$
declare
  v_sub subscriptions%rowtype;
begin
  select * into v_sub from subscriptions where id = p_subscription_id;
  if v_sub.id is null then raise exception 'subscription not found'; end if;
  if not (is_admin() or is_service_manager_for(v_sub.license_id)) then
    raise exception 'not authorized to edit this subscription';
  end if;

  update subscriptions set
    notes = nullif(trim(p_notes), ''),
    product_key = nullif(trim(p_product_key), ''),
    invoice_number = nullif(trim(p_invoice_number), ''),
    price_at_signup = p_price_paid
  where id = p_subscription_id;
end;
$$;

-- ─── RPC: get_finance_export — add product_key/invoice_number ──────────────
-- Adds new OUT columns, so Postgres won't let create-or-replace alter the
-- existing return type in place — drop it first.
drop function if exists get_finance_export(date, date);

create function get_finance_export(p_start_date date, p_end_date date)
returns table(
  user_email text, license_name text, billing_label text, cost numeric, price_paid numeric,
  product_key text, invoice_number text, start_date date, renewed_date date, status text, notes text
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
    s.product_key,
    s.invoice_number,
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

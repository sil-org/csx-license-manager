-- start_renewal_period() (63, fixed in 67) returned o.price_at_signup — the
-- subscription's price snapshot from its INITIAL purchase, which can be
-- pro-rated (calc_prorated_cost()) or hand-corrected to a one-time invoice
-- amount via update_subscription_details(). A renewal is always billed at
-- the license's current full annual price, not that snapshot, so this swaps
-- the returned column to l.price and renames it renewal_price so callers
-- can't mistake it for the signup amount again. Column rename requires
-- dropping first — CREATE OR REPLACE can't rename an OUT parameter.
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
    l.price, o.renewal_month, l.reminder_message
  from opened o
  join licenses l on l.id = o.license_id;
end;
$$;

-- Fixes start_renewal_period() (63): its RETURNS TABLE(subscription_id uuid,
-- ...) declares an implicit "subscription_id" variable in the function's own
-- scope, which collides with renewals.subscription_id referenced unqualified
-- in the logged CTE's RETURNING clause — Postgres can't tell which one you
-- mean and raises "column reference \"subscription_id\" is ambiguous" on
-- every call. Same class of bug as 64_admin_update_subscription_suite_key_
-- ambiguous_fix.sql; same fix, qualify it.
create or replace function start_renewal_period(p_license_id uuid, p_fiscal_year int)
returns table(
  subscription_id uuid, user_email text, license_name text, billing_label text,
  price_at_signup numeric, renewal_month int, reminder_message text
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
      s.price_at_signup, s.renewal_month, s.license_id
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
    o.price_at_signup, o.renewal_month, l.reminder_message
  from opened o
  join licenses l on l.id = o.license_id;
end;
$$;

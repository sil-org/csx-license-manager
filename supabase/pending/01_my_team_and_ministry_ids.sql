-- Run this in the Supabase SQL Editor. Adds: My Team page support, and the
-- Admin: Ministry IDs page's write RPC. Safe to run once against the live DB.

create or replace function get_report_emails()
returns setof text language sql stable security definer as $$
  with recursive reports as (
    select lower(p.primary_email) as email
    from profiles p
    where lower(p.manager_email) = lower(current_profile_email())
    union
    select lower(p.primary_email)
    from profiles p
    join reports r on lower(p.manager_email) = r.email
  )
  select email from reports
$$;

create or replace function is_org_manager()
returns boolean language sql stable security definer as $$
  select exists(select 1 from profiles where lower(manager_email) = lower(current_profile_email()))
$$;

alter policy "subscriptions: read own or authority" on subscriptions
  using (
    user_email = current_profile_email()
    or is_admin()
    or (suite_key is not null and is_suite_key_owner(suite_key))
    or is_service_manager_for(license_id)
    or lower(user_email) in (select get_report_emails())
  );

create or replace function admin_update_ministry_id(p_email text, p_ministry_id text)
returns void language plpgsql security definer as $$
declare
  v_email text := lower(trim(p_email));
  v_id text := nullif(trim(p_ministry_id), '');
begin
  if not is_admin() then raise exception 'admin only'; end if;
  if v_email = '' then raise exception 'email is required'; end if;

  if v_id is null then
    delete from ministry_ids where email = v_email;
    return;
  end if;

  if v_id !~ '^\d{6}$' then raise exception 'ministry ID must be exactly 6 digits'; end if;

  insert into ministry_ids (email, ministry_id) values (v_email, v_id)
  on conflict (email) do update set ministry_id = excluded.ministry_id;
end;
$$;

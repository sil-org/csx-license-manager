-- description is no longer admin-editable at all, in the UI or via the RPC —
-- it's exclusively driven by the daily suite_keys_current sync (see
-- 65_suite_key_description_from_cost_center.sql). admin_update_suite_key_owner()
-- previously took a p_description param and overwrote description with
-- whatever the admin typed; that's removed outright rather than just
-- ignored, so there's no lingering parameter suggesting it still does
-- something.
-- A pre-p_description 3-arg overload apparently still lingers in the live
-- database alongside the 4-arg one below (Postgres doesn't collapse
-- overloads that only ever grew via CREATE OR REPLACE with a different
-- parameter count) — drop both so the CREATE below can't collide with
-- either on parameter naming.
drop function if exists admin_update_suite_key_owner(text, text, text);
drop function if exists admin_update_suite_key_owner(text, text, text, text);

create or replace function admin_update_suite_key_owner(
  p_suite_key text, p_new_owner_email text, p_owner_group_email text default null
) returns table(id uuid, user_email text, license_name text)
language plpgsql security definer as $$
declare
  v_owner text := nullif(lower(trim(p_new_owner_email)), '');
  v_group text := nullif(lower(trim(p_owner_group_email)), '');
  v_canonical_key text;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  p_suite_key := regexp_replace(trim(p_suite_key), '~.*$', '');
  if p_suite_key = '' then raise exception 'suite key is required'; end if;
  if v_owner is not null and v_group is not null then
    raise exception 'a suite key can have an individual owner or a group owner, not both';
  end if;

  select suite_key into v_canonical_key from suite_keys where lower(suite_key) = lower(p_suite_key);
  if v_canonical_key is not null then
    p_suite_key := v_canonical_key;
  end if;

  insert into suite_keys (suite_key, owner_email, owner_group_email)
  values (p_suite_key, v_owner, v_group)
  on conflict (suite_key) do update
    set owner_email = v_owner,
        owner_group_email = v_group,
        pending_owner_email = case when v_owner is not null or v_group is not null then null else suite_keys.pending_owner_email end,
        pending_owner_is_group = case when v_owner is not null or v_group is not null then false else suite_keys.pending_owner_is_group end;

  if v_group is not null then
    return query
      update subscriptions s
      set status = 'pending', pending_approver_email = null
      from licenses l
      where s.suite_key = p_suite_key and s.status = 'pending_sk_verification' and l.id = s.license_id
      returning s.id, s.user_email, l.name;
  elsif v_owner is not null then
    return query
      update subscriptions s
      set pending_approver_email = v_owner
      from licenses l
      where s.suite_key = p_suite_key and s.status = 'pending_sk_verification' and l.id = s.license_id
      returning s.id, s.user_email, l.name;
  end if;
end;
$$;

-- Run this in the Supabase SQL Editor. Fixes the "Confirm as {approver}"
-- quick-confirm button in Admin: SuiteKeys, which looked like it did
-- nothing (and, per the previous RPC, could touch a totally unrelated
-- pending request from someone else who happened to share the same
-- SuiteKey with a different suggested approver).
--
-- Root cause: the quick-confirm button was calling
-- admin_update_suite_key_owner(), which is for "an admin is assigning a new
-- owner who still needs to confirm themselves" — it deliberately leaves
-- affected subscriptions in pending_sk_verification. Quick-confirm means the
-- opposite (the approver already confirmed out-of-band), so it needs its
-- own RPC that actually advances things, scoped to that specific approver's
-- own pending requests only.

create or replace function admin_confirm_sk_ownership(p_suite_key text, p_owner_email text)
returns table(id uuid, user_email text, license_name text)
language plpgsql security definer as $$
declare
  v_owner text := nullif(lower(trim(p_owner_email)), '');
  v_admin text := current_profile_email();
begin
  if not is_admin() then raise exception 'admin only'; end if;
  p_suite_key := trim(p_suite_key);
  if v_owner is null then raise exception 'owner email is required'; end if;

  update suite_keys set owner_email = v_owner, owner_group_email = null
  where suite_key = p_suite_key;
  if not found then raise exception 'suite key not found'; end if;

  insert into audit_log (action, suite_key, performed_by)
  values ('sk_verified', p_suite_key, v_admin);

  return query
    update subscriptions s
    set status = 'pending', pending_approver_email = null
    from licenses l
    where s.suite_key = p_suite_key and s.status = 'pending_sk_verification'
      and s.pending_approver_email = v_owner and l.id = s.license_id
    returning s.id, s.user_email, l.name;
end;
$$;

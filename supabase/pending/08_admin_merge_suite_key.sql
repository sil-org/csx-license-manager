-- Run this in the Supabase SQL Editor. Adds a way to fix data-entry typos —
-- e.g. someone types "Relations-U_SIL~5407" instead of the real
-- "Relations-U_SIL" — that create a genuinely different (not just case- or
-- whitespace-different) suite_keys row. There was previously no way to
-- delete it: subscriptions.suite_key's foreign key blocks a plain delete
-- while any subscription still points at the bad key.
--
-- New "Merge into…" button in Admin: SuiteKeys (only shown for unowned
-- keys) repoints affected subscriptions onto the correct key, then deletes
-- the bad row. Refuses server-side if the "bad" key actually has an owner
-- on file, since that's very unlikely to really be a typo.

alter type audit_action add value if not exists 'sk_merged';

create or replace function admin_merge_suite_key(p_bad_key text, p_correct_key text)
returns void language plpgsql security definer as $$
declare
  v_bad text := trim(p_bad_key);
  v_correct text;
begin
  if not is_admin() then raise exception 'admin only'; end if;
  if v_bad = '' or p_correct_key is null or trim(p_correct_key) = '' then
    raise exception 'both the bad and correct suite keys are required';
  end if;

  select suite_key into v_correct from suite_keys where lower(suite_key) = lower(trim(p_correct_key));
  if v_correct is null then raise exception 'suite key % does not exist', p_correct_key; end if;

  if lower(v_bad) = lower(v_correct) then
    raise exception 'bad and correct suite keys must be different';
  end if;

  if exists (
    select 1 from suite_keys where suite_key = v_bad and (owner_email is not null or owner_group_email is not null)
  ) then
    raise exception 'suite key % has an owner on file — this looks like a real key, not a typo', v_bad;
  end if;

  update subscriptions set suite_key = v_correct where suite_key = v_bad;

  insert into audit_log (action, suite_key, performed_by, notes)
  values ('sk_merged', v_correct, current_profile_email(), 'merged from "' || v_bad || '"');

  delete from suite_keys where suite_key = v_bad;
end;
$$;

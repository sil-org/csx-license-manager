-- Run this in the Supabase SQL Editor. Adds the reactivate side of
-- deactivate_license(), which was missing entirely — there was previously
-- no way to bring a deactivated license back other than raw SQL.
--
-- Also relevant: save_license()'s UPDATE branch deliberately never touches
-- `active` (confirmed while reading it) — deactivating/reactivating is a
-- distinct, confirmed action now, not a field you'd casually toggle while
-- editing everything else on a license.

create or replace function reactivate_license(p_license_id uuid)
returns void language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;
  update licenses set active = true where id = p_license_id;
end;
$$;

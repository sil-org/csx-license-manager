-- Site-wide announcement banner, admin-editable via /admin/announcements.
-- Deliberately a singleton row (fixed id), not a multi-row table like
-- ministry_ids/area_discounts — there's exactly one "current" banner and no
-- need to browse history, so a plain update-in-place avoids list UI and
-- "which row is active" bookkeeping the admin page would otherwise need.
--
-- No start/end date scheduling — same "explicit admin action" philosophy as
-- 63_manual_renewal_periods.sql: the admin flips `enabled` on and off rather
-- than the app inferring visibility from dates.

create table if not exists announcements (
  id         uuid primary key,
  message    text not null default '',
  cta_label  text,
  cta_url    text,
  enabled    boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Seed the one row the app will ever update. Fixed, well-known id so
-- admin_save_announcement() can target it unconditionally.
insert into announcements (id, message, enabled)
values ('00000000-0000-0000-0000-000000000001', '', false)
on conflict (id) do nothing;

alter table announcements enable row level security;

drop policy if exists "announcements: read enabled or admin" on announcements;
create policy "announcements: read enabled or admin" on announcements for select
  using (enabled or is_admin());

drop policy if exists "announcements: admin write" on announcements;
create policy "announcements: admin write" on announcements for all
  using (is_admin()) with check (is_admin());

-- Writes go through this RPC, not a raw .update(), same convention as other
-- admin_* mutations (e.g. admin_add_area_discount in 73_area_pricing.sql):
-- keeps the admin check and validation server-side regardless of RLS.
create or replace function admin_save_announcement(
  p_message   text,
  p_cta_label text,
  p_cta_url   text,
  p_enabled   boolean
) returns void language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'admin only'; end if;

  if p_enabled and nullif(trim(p_message), '') is null then
    raise exception 'message is required to enable the announcement';
  end if;

  if nullif(trim(coalesce(p_cta_url, '')), '') is not null
     and p_cta_url !~ '^https?://' then
    raise exception 'call-to-action URL must start with http:// or https://';
  end if;

  update announcements
  set message    = trim(coalesce(p_message, '')),
      cta_label  = nullif(trim(coalesce(p_cta_label, '')), ''),
      cta_url    = nullif(trim(coalesce(p_cta_url, '')), ''),
      enabled    = p_enabled,
      updated_at = now(),
      updated_by = current_profile_email()
  where id = '00000000-0000-0000-0000-000000000001';
end;
$$;

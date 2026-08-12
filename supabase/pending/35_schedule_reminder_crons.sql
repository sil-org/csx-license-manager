-- Schedules the two weekly reminder digests (send-renewal-reminders,
-- send-pending-reminders) via pg_cron + pg_net — the CLI-first alternative
-- to the Supabase Dashboard's Cron UI (Project → Edge Functions → the
-- function → Cron), which does the same thing under the hood.
--
-- Auth: the Authorization header below references a name in Supabase Vault
-- ('cron_secret'), not a literal secret — this file is committed to git, so
-- the actual value never lands in it. The same value was set as both
-- functions' CRON_SECRET Edge Function secret (`supabase secrets set
-- CRON_SECRET=... --project-ref lxomebvymgolbzgkxqgu`) and stored here via
-- `select vault.create_secret('<value>', 'cron_secret', '...')`, run once,
-- directly, not as a committed migration. See the header comment in
-- send-renewal-reminders/index.ts for why this project can't just rely on
-- Supabase's platform-level JWT verification instead (this project's
-- client-facing key is the newer sb_publishable_... format, which that gate
-- doesn't understand).
--
-- Timing: fixed UTC times approximating gas-legacy/src/Emails.gs's Monday
-- 8 AM America/Chicago trigger. pg_cron schedules run in UTC with no
-- timezone-of-day awareness, so this does NOT follow Chicago across DST —
-- it'll actually fire at 7 AM Central during CST (Nov-Mar) instead of 8 AM.
-- Fine for a weekly reminder email; adjust the two schedule strings below by
-- hand each DST transition if that hour matters.
--
-- Idempotent: unschedule-if-exists before scheduling, rather than relying on
-- cron.schedule()'s upsert-by-job-name behavior (present in modern pg_cron,
-- but not guaranteed across versions) — safe to re-run this file.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

do $$ begin perform cron.unschedule('weekly-renewal-reminders'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('weekly-pending-reminders'); exception when others then null; end $$;

select cron.schedule(
  'weekly-renewal-reminders',
  '0 13 * * 1', -- Monday 8 AM CDT (13:00 UTC)
  $$
  select net.http_post(
    url := 'https://lxomebvymgolbzgkxqgu.supabase.co/functions/v1/send-renewal-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'weekly-pending-reminders',
  '5 13 * * 1', -- Monday 8:05 AM CDT — offset a few minutes from the renewal job so they don't both cold-start at once
  $$
  select net.http_post(
    url := 'https://lxomebvymgolbzgkxqgu.supabase.co/functions/v1/send-pending-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

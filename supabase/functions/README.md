Put Supabase Edge Functions here (e.g. `send-email/index.ts`). The deploy
workflow (`.github/workflows/deploy.yml`) deploys everything in this
directory automatically on push to `main`. If you don't need any functions
yet, leave this directory empty and remove the `deploy-edge-functions` job.

## Scheduled functions

`sync-group-memberships`, `sync-provisioning`, `send-renewal-reminders`, and
`send-pending-reminders` are all jobs meant to run on a timer, not just when
something else calls them — none has a schedule wired up yet, and each needs
one set up by hand:

- **Supabase Dashboard** (simplest): Project → Edge Functions → the function
  → Cron, or Database → Cron Jobs if your project has that UI. Every 15-30
  min is plenty for `sync-group-memberships`/`sync-provisioning`; the two
  `send-*-reminders` functions are meant to run weekly (mirrors
  `gas-legacy/src/Emails.gs`'s Monday 8 AM CT trigger — pick whatever weekly
  time works).
- **`pg_cron` + `pg_net`**, if the dashboard cron UI isn't available: enable
  both extensions, then schedule an HTTP POST to the function's URL. This is
  how `send-renewal-reminders`/`send-pending-reminders` are actually wired up
  — see `supabase/pending/35_schedule_reminder_crons.sql`.

`send-renewal-reminders` and `send-pending-reminders` are deployed with
`--no-verify-jwt` (like `send-email`) and check their own `CRON_SECRET`
instead of relying on Supabase's platform-level JWT verification — that gate
only understands legacy JWT-format anon/service_role keys, and this project's
client-facing key has moved to the newer `sb_publishable_...` format (see
`.env`), which the gate rejects outright regardless of who's calling. Set
`CRON_SECRET` via `supabase secrets set`, and store the same value in
Supabase Vault (`vault.create_secret(..., 'cron_secret')`) so the scheduling
SQL can reference it by name instead of a literal secret landing in a
committed file — see the header comment in `send-renewal-reminders/index.ts`
for the full reasoning.

**Every function here is deployed with `--no-verify-jwt`** (the deploy
workflow passes it for all of them), so each one must authenticate its own
callers — there is no platform gate behind it:

- `send-email`, `sync-provisioning`: a signed-in user with a profile in this
  app (verified with `auth.getUser()` + `linked_accounts`), the service-role
  key, or `CRON_SECRET`.
- `feedback`, `classify-approver-email`: a signed-in user.
- `send-*-reminders`, `sync-group-memberships`: `CRON_SECRET` (or the
  service-role key, for `sync-group-memberships`).

Checking only that an `Authorization` header is *present* is not
authentication — anyone can send one.
`sync-provisioning` additionally needs `CUBEBACKUP_API_KEY` (or future
adapters' equivalents) set via `supabase secrets set` before it can do
anything beyond a no-op run.

`send-renewal-reminders` and `send-pending-reminders` both call `send-email`
internally (one Resend call per recipient digest) rather than duplicating the
Resend/email_log logic — same reasoning as every other notification path in
this app funneling through that one function.

## `send-email` authentication and per-app senders

`send-email` is deployed with `--no-verify-jwt`, so it authenticates callers itself (`send-email/auth.ts`):
it accepts the service-role key or `CRON_SECRET` (server-to-server — e.g. the reminder functions) or a
valid signed-in user's access token whose user has a `linked_accounts` profile in this app (the browser app —
this Supabase project is shared with other apps, so a session alone isn't enough). It used to accept *any*
`Authorization` header value; anything else is now a 401. Each send records the verified caller in
`email_log.sent_by` (the user's email, or `system`).

The request may carry `app` to pick the sender: `licenses` (default — existing callers are unchanged) or
`contracts` (`Contract Repository <contracts@em.sil.org>`, used by the contract-repository app; server-to-server
callers only). Senders come from a fixed list in `auth.ts`; callers can never supply a `from`. Optional secret
`CONTRACTS_REPLY_TO` sets the contracts reply-to address.

Tests: `deno test supabase/functions/send-email/auth_test.ts` (unit) and
`deno run -A --no-check supabase/functions/send-email/e2e_check.ts` (the real handler with Resend and Supabase mocked).

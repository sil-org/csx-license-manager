Put Supabase Edge Functions here (e.g. `send-email/index.ts`). The deploy
workflow (`.github/workflows/deploy.yml`) deploys everything in this
directory automatically on push to `main`. If you don't need any functions
yet, leave this directory empty and remove the `deploy-edge-functions` job.

## Scheduled functions

`sync-group-memberships` and `sync-provisioning` are both reconciliation jobs
meant to run on a timer, not just when something else calls them — neither
has a schedule wired up yet, and needs one set up by hand:

- **Supabase Dashboard** (simplest): Project → Edge Functions → the function
  → Cron, or Database → Cron Jobs if your project has that UI. Every 15-30
  min is plenty for either function.
- **`pg_cron` + `pg_net`**, if the dashboard cron UI isn't available: enable
  both extensions, then schedule an HTTP POST to the function's URL.

Either way, the request needs a real `Authorization: Bearer <anon-or-service-role-key>`
header — both functions are deployed with JWT verification on (unlike
`send-email`, which only checks that *some* Authorization header is present).
`sync-provisioning` additionally needs `CUBEBACKUP_API_KEY` (or future
adapters' equivalents) set via `supabase secrets set` before it can do
anything beyond a no-op run.

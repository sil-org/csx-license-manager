# License Manager

Software license/subscription request and approval tool for SIL staff.
Built on [`sil-app-template`](https://github.com/kode-monki/sil-app-template):
React + Vite + Tailwind frontend, Supabase (Postgres + Auth + RLS) backend.
Frontend hosting is AWS Amplify (connected to this repo, builds/deploys on
push to `main`); Supabase Edge Functions deploy via GitHub Actions.

Ported from a Google Apps Script + Sheets app — the original source is kept
under `gas-legacy/` for reference.

## Setup

Follow `SETUP.md`, then run both schema files in the Supabase SQL Editor, in order:

1. `supabase/schema.sql` — the auth kernel (profiles, Google account linking, roles)
2. `supabase/schema_licenses.sql` — the domain schema (licenses, subscriptions,
   suite keys, approvals, audit log)

## What's here

- **Catalog** (`/catalog`) — browse/search active licenses, request a
  subscription (SuiteKey with typeahead, Ministry ID, or GTIS-sponsored)
- **My Subscriptions** (`/subscriptions`) — view your requests, cancel, opt
  in/out of renewal
- **Action Center** (`/action-center`) — for SuiteKey owners: verify SuiteKey
  ownership, approve/decline requests. Not role-gated in the UI — it's empty
  unless you own a SuiteKey (enforced by RLS). Provisioning and cancellation
  live on Admin → All Subscriptions instead (see below)
- **My Team** (`/my-team`) — for people managers: every active/pending
  subscription used by your direct and indirect reports (`profiles.manager_email`)
- **SuiteKey Charges** (`/suite-key-charges`) — every charge against any
  SuiteKey you own, individually or via a Google Group
- **FAQ** (`/faq`)
- **Admin → Catalog** — create/edit/deactivate licenses, with search
- **Admin → All Subscriptions** — for admins, every subscription, every user,
  every status, unfiltered; also open to license service managers, for whom
  RLS narrows it to their own/managed rows. Mark approved subscriptions
  active (with a link to the vendor portal), and cancel any non-terminal
  request with an optional reason emailed to the subscriber
- **Admin → Audit Log** — full history of every request/approval/decline/
  activation/cancellation/revocation/merge, with search
- **Admin → Finance Export** — pro-rated cost export (CSV or on-screen
  preview) for a date range
- **Admin → SuiteKeys** — assign/reassign owners (individual or Google
  Group), quick-confirm a suggested approver on their behalf, search, and
  merge a mistyped SuiteKey into the correct one
- **Admin → Ministry IDs** — assign/edit staff Ministry IDs, with search
- **Admin → Import** — bulk-import already-active subscriptions from a CSV
  (for historical/legacy data)
- **Admin → Users** — promote/demote admins (previously only possible via
  raw SQL)

All the state-transition logic (who can approve what, valid status
transitions, SuiteKey matching/merging, finance math) lives in Postgres RPCs
in `supabase/schema_licenses.sql` rather than in the frontend — the UI just
calls them. New migrations land in `supabase/pending/` as numbered `.sql`
files (run them in order in the Supabase SQL Editor) before being folded
into `schema_licenses.sql` as the living source of truth.

## What's not ported yet

See the header comment in `supabase/schema_licenses.sql` for the full list.
The big ones:

- **Email notifications** — built and live (Resend, via the `send-email`
  Edge Function — see `supabase/functions/README.md`), sending from
  `license_manager@em.sil.org`.
- **Google Group membership sync on activation** — activating a subscription
  doesn't automatically add the user to the *license's own* Google Group
  (separate from SuiteKey *ownership* groups, which do work). Needs an Edge
  Function calling the Admin SDK Directory API; `activate_subscription()`
  leaves a TODO note in the audit log instead.
- **SuiteKey group-ownership sync itself isn't scheduled yet** — the
  `sync-group-memberships` Edge Function exists and is deployed, but needs a
  one-time external Google Cloud/Workspace setup (domain-wide-delegated
  service account) before it can actually run on a schedule. Until then,
  group-owned SuiteKeys won't reflect current Google Group membership.
- **External vendor provisioning** — a generalized adapter framework (the
  `sync-provisioning` Edge Function, `licenses.provisioning_adapter`/
  `provisioning_config`, `provisioning_log`) reconciles active subscriptions
  against a vendor's own roster, same reconciliation model as
  `sync-group-memberships`. First adapter is CubeBackup (Google Backup); to
  turn it on for a license, set Admin → Catalog's Provisioning dropdown to
  CubeBackup with `{"baseUrl": "...", "domain": "..."}`, and set the
  `CUBEBACKUP_API_KEY` secret. Not scheduled yet (see
  `supabase/functions/README.md`) — the fire-and-forget kick from
  Admin → All Subscriptions/My Subscriptions covers the common case in the meantime, but a
  schedule is the correctness backstop for anything that misses. Adding the
  next vendor is one adapter file (`supabase/functions/sync-provisioning/adapters/`)
  + a dropdown entry, not a new schema/Edge Function.
- **Historical data migration** — Admin → Import can now do this, but the
  actual one-time import of historical subscriptions/renewals/audit log from
  the old GAS sheet hasn't been run yet.
- Requesting a subscription *on behalf of* someone else — only self-service
  requests are supported for now.
- **Weekly renewal-reminder and pending-approval digest emails** — built
  (`send-renewal-reminders`/`send-pending-reminders` Edge Functions; TO the
  subscription owner, CC the original requester if different — issue #3), but
  like `sync-group-memberships`/`sync-provisioning`, not scheduled yet (see
  `supabase/functions/README.md`). Admin → All Subscriptions can also send a
  one-off renewal reminder for a single subscription in the meantime.
- The Gmail-inbox provisioning-scanner automation (GAS/Sheets-specific, no
  direct equivalent needed here).

## Branding

Same SIL brand kit as the template: colors and typography from the SIL
Brand Resource Center, SIL wordmark on the sign-in page. See
`sil-app-template`'s README for details/sourcing.

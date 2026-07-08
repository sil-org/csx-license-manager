# License Manager

Software license/subscription request and approval tool for SIL staff.
Built on [`sil-app-template`](https://github.com/kode-monki/sil-app-template):
React + Vite + Tailwind frontend, Supabase (Postgres + Auth + RLS) backend,
deployed to AWS S3/CloudFront via GitHub Actions.

Ported from a Google Apps Script + Sheets app — the original source is kept
under `gas-legacy/` for reference.

## Setup

Follow `SETUP.md`, then run both schema files in the Supabase SQL Editor, in order:

1. `supabase/schema.sql` — the auth kernel (profiles, Google account linking, roles)
2. `supabase/schema_licenses.sql` — the domain schema (licenses, subscriptions,
   suite keys, approvals, audit log)

## What's here

- **Catalog** (`/catalog`) — browse active licenses, request a subscription
  (Suite Key, Ministry ID, or GTIS-sponsored)
- **My Subscriptions** (`/subscriptions`) — view your requests, cancel, opt
  in/out of renewal
- **Approvals** (`/approvals`) — for Suite Key owners and license service
  managers: verify Suite Key ownership, approve/decline requests, mark
  approved licenses as provisioned. Not role-gated in the UI — it's empty
  unless you own a Suite Key or service-manage a license (enforced by RLS)
- **Admin → Catalog** (`/admin/catalog`) — create/edit/deactivate licenses
- **Admin → Audit Log** (`/admin/audit-log`) — full history of every
  request/approval/decline/activation/cancellation/revocation

All the state-transition logic (who can approve what, valid status
transitions) lives in Postgres RPCs in `supabase/schema_licenses.sql`
(`request_subscription`, `approve_subscription`, `activate_subscription`,
etc.) rather than in the frontend — the UI just calls them.

## What's not ported yet

See the header comment in `supabase/schema_licenses.sql` for the full list.
The big ones:

- **Email notifications** — the original sent an email at every step
  (request submitted, approval needed, approved, renewal reminder). None of
  that is wired up; add Supabase Edge Functions triggered from the RPCs
  above (`supabase/functions/README.md`).
- **Google Group membership sync** — activating a subscription no longer
  automatically adds the user to the license's Google Group. Needs an Edge
  Function calling the Admin SDK Directory API with a service account.
  `activate_subscription()` leaves a TODO note in the audit log instead.
- **Org-hierarchy "my team's subscriptions" view** — `profiles` has
  `department`/`manager_email` columns ready for it, but the recursive
  reports lookup and UI aren't built.
- Finance export, bulk CSV import, and the Gmail-inbox provisioning-scanner
  automation (all GAS/Sheets-specific, no direct equivalent needed here).
- Requesting a subscription *on behalf of* someone else — only self-service
  requests are supported for now.

## Branding

Same SIL brand kit as the template: colors and typography from the SIL
Brand Resource Center, SIL wordmark on the sign-in page. See
`sil-app-template`'s README for details/sourcing.

# License Manager — developer context for Claude

SIL software license/subscription request-and-approval tool. React + Vite +
Tailwind frontend, Supabase (Postgres + Auth + RLS + Edge Functions) backend.
Ported from a Google Apps Script app (kept in `gas-legacy/` for reference only).
`README.md` has the feature tour; `SETUP.md` has the one-time external setup.
This file is the fast on-ramp — keep it short and current.

> **Maintenance:** refreshed weekly by a scheduled task. See "Weekly refresh
> routine" at the bottom. Last reviewed: **2026-11-02** at commit `2d633f8`
> (v0.2.10).

## 1. Get the repo running

```bash
git clone https://github.com/kode-monki/license-manager && cd license-manager
cp .env.example .env     # fill VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_SSO_PROVIDER_ID
npm install
npm run dev              # http://localhost:<port from vite.config.js> (fixed, strictPort —
                         # the Supabase OAuth redirect allowlist is keyed to that exact port)
npm run build            # production build (what Amplify runs)
```

- Node 22 works. There is **no lint and no frontend test suite**; `npm run build`
  is the only automated check for the frontend.
- Edge Function tests need Deno: `deno test supabase/functions/send-email/auth_test.ts`
  and `deno run -A --no-check supabase/functions/send-email/e2e_check.ts`.
- Real sign-in requires Google OAuth (SIL accounts) against the shared Supabase
  project. The `.env` values (Supabase URL/anon key, SSO provider ID) are in the
  **1Password "license manager" vault**; never commit `.env`.
- Make yourself admin after first sign-in: see `SETUP.md` §8.

## 2. Architecture in one screen

- `src/pages/` (user pages) and `src/pages/admin/` (admin tabs); routes in
  `src/App.jsx`, nav in `src/navLinks.js`. `src/lib/*.js` are thin wrappers
  that call Supabase RPCs. `src/context/AuthContext.jsx` owns the session.
- **Business logic lives in Postgres RPCs, not the frontend** (approval rules,
  status transitions, SuiteKey matching/merging, finance math). The UI just calls
  them. Authorization is RLS + RPC checks.
- `supabase/schema.sql` = auth kernel (profiles, linked accounts, roles).
  `supabase/schema_licenses.sql` = living domain schema (re-runnable; enums are
  guarded). **The Supabase project is shared with other SIL apps** (e.g. a
  contracts app), so a valid session alone is not enough — check the
  `linked_accounts`/profile for this app.
- `supabase/functions/` Edge Functions, all deployed with `--no-verify-jwt`, so
  **each must authenticate its own callers** (see `supabase/functions/README.md`).
  Functions: `send-email` (Resend), `feedback` (emails help desk),
  `classify-approver-email`, `sync-group-memberships`, `sync-provisioning`
  (adapter framework; CubeBackup first), `send-renewal-reminders`,
  `send-pending-reminders`.
- Hosting: AWS Amplify auto-builds the frontend on push to `main`. GitHub
  Actions (`.github/workflows/deploy.yml`) only deploys Edge Functions on push
  to `main`. HSTS is being ramped in `customHttp.yml` (currently max-age 1 month).

## 3. Database migration workflow

- New migrations are numbered files in `supabase/pending/` (latest: `84_*`).
  They're run by hand, in order, in the Supabase SQL Editor, then folded into
  `schema_licenses.sql`. Numbers 72, 78 and 79 each have two files, and 76 is
  absent — pick the next free number above the highest (85+).
- Whenever you change an RPC signature, drop the old overload (an overload
  ambiguity caused issue #23).
- All of `supabase/pending/` (through 84) has been applied to production
  (83 confirmed by Kate 2026-11-02; 84 confirmed 2026-11-04). Anything above 84 is
  unapplied until told otherwise.

## 4. Conventions

- Develop on the branch you're assigned; don't push to `main` directly; don't
  open a PR unless asked. Bump `package.json` version for user-visible changes
  (recent commits do this).
- Don't put user emails or other PII from GitHub issues into committed files.
- SIL brand kit applies to UI (colors/typography per `sil-app-template`).

## 5. Outstanding to-dos (as of 2026-11-02)

**Open PRs**
- #27 Dependabot: fast-uri 3.1.8 → 3.1.9 (security fixes; dev-only transitive dep) — recommend merge.
- #28 Dependabot: serialize-javascript 7.0.7 → 7.1.4 (security fixes; dev-only transitive dep, build tooling) — recommend merge.

**Open GitHub issues** (all user-submitted; none assigned)
- Bugs: #23 "Could not choose the best candidate function" when requesting
  Claude Premium (likely the duplicate `request_subscription` overload —
  migration 81 dropped one; verify it's applied in prod, then close);
  #8 Storage quota form shows FY2026 instead of FY2027; #6 SuiteKey change on
  renewable subscriptions.
- Requests: #5, #7 change SuiteKey on existing subscriptions (same need as #6 —
  a user-facing "change SuiteKey" flow doesn't exist); #17 charge missing from
  project YTD statement (investigate billing/ledger, may be support-only);
  #10 Gemini comment (likely no action); #3 renewal notices to target account +
  requester (reminder functions were built for this — confirm and close);
  #2 show price paid on every subscription (migrations 71/72/77 touched this —
  confirm remaining gap).

**Known unfinished work** (from `README.md` "What's not ported yet")
- Schedule the four cron-style Edge Functions: `sync-group-memberships`,
  `sync-provisioning`, `send-renewal-reminders`, `send-pending-reminders`
  (reminders via pg_cron in `supabase/pending/35_*`; the other two need setup).
- `sync-group-memberships` needs a Google Workspace domain-wide-delegation
  service account before it can run.
- Adding users to a license's own Google Group on activation — not built.
- One-time import of historical GAS data via Admin → Import — not yet run.
- Requesting on behalf of someone else — partially supported
  (`p_recipient_email`); README still says not ported, reconcile.
- `supabase/functions/sync-provisioning/adapters/cubebackup.ts:109` — TODO:
  verify CubeBackup API before relying on it in production.
- `IDEAS.md` backlog is empty.

## 6. Weekly refresh routine (for the scheduled task)

1. `git fetch origin main`; compare `origin/main` to the "Last reviewed" commit
   above (`git log <sha>..origin/main --oneline`). Also check open PRs/issues
   (GitHub MCP tools; `gh` is not available).
2. **If nothing changed** (no new commits, and no change in open PRs/issues),
   stop without editing or pushing anything.
3. If something changed, update this file only where needed: setup steps,
   architecture notes, latest migration number, the to-do list (add new, strike
   finished), and the "Last reviewed" line. Cross-check `README.md`/`SETUP.md`
   for staleness but prefer fixing those separately and briefly.
4. Commit to the assigned `claude/…` branch and push. No PR unless asked.

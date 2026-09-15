-- One-time data repair, not a schema change. Not a UI bug after all (an
-- earlier version of this comment blamed Admin -> Catalog's Billing cycle
-- dropdown, but the timestamps don't support that — see below). Seven
-- licenses (Google Vids, Box.com, InCopy, RoboHelp, InDesign, Animate,
-- Adobe Stock) all carry the identical created_at 2026-07-09 17:40:22.69138
-- down to the millisecond, with legacy_id null. That's a single bulk CSV
-- import — admin_import_licenses() (17_gas_historical_import.sql) inserts
-- every row of a batch inside one PL/pgSQL call, i.e. one transaction, i.e.
-- one now() value — using Admin -> Import's "GAS Licenses" positional CSV
-- path (column 11 = renewal_reminder, see parseGasLicenses() in
-- src/pages/admin/Import.jsx) to bulk-add 7 brand-new licenses at once,
-- not to backfill historical GAS rows (a real legacy row would carry a
-- legacy_id).
--
-- admin_import_licenses() only defaults renewal_reminder to true when the
-- CSV cell is blank — it takes an explicit value as-is. For all 7 rows to
-- land false, that column held an explicit false for every row, almost
-- certainly because whoever built that CSV started from a template/earlier
-- row that predated the renewal-reminder feature and never updated the
-- column before uploading.
--
-- Scoped to legacy_id is null so this can't touch a genuine historical
-- GAS-import row, which can legitimately carry an intentional false coming
-- straight from the old spreadsheet.
--
-- Google Vids (a0ce92c3-6d06-43c6-853e-562545295f7f) is excluded on purpose
-- — confirmed with Kate that it genuinely doesn't need renewal reminders
-- (unlike the other 6, its false wasn't a leftover CSV artifact) — so it's
-- carved out explicitly rather than assumed to be part of the same mistake.
--
-- Run the SELECT first to see exactly what this will touch before running
-- the two UPDATEs below.

select id, name, created_at, renewal_reminder
from licenses
where billing_cycle = 'annual'
  and renewal_reminder = false
  and legacy_id is null
  and id <> 'a0ce92c3-6d06-43c6-853e-562545295f7f';

-- Fix the license-level default so any *future* subscription of these
-- licenses no longer inherits renewal_reminder = false at signup.
update licenses
set renewal_reminder = true
where billing_cycle = 'annual'
  and renewal_reminder = false
  and legacy_id is null
  and id <> 'a0ce92c3-6d06-43c6-853e-562545295f7f';

-- Fix the *existing* subscriptions of those same licenses. renewal_reminder
-- on subscriptions is a snapshot taken at request time, so the license-level
-- fix above never touches rows that already exist — without this, InDesign's
-- current subscribers would still be silently excluded from FY27 renewals.
update subscriptions s
set renewal_reminder = true
from licenses l
where s.license_id = l.id
  and l.billing_cycle = 'annual'
  and l.legacy_id is null
  and l.id <> 'a0ce92c3-6d06-43c6-853e-562545295f7f'
  and s.renewal_reminder = false;

-- Run this in the Supabase SQL Editor.
--
-- Bug: gas-legacy/src/Subscriptions.gs's export builds
-- `priceAtSignup: Number(r[13]) || 0` — any row where the old Sheet's price
-- cell was blank (price never recorded) got coerced to 0 instead of staying
-- empty. 17_gas_historical_import.sql's importer only nullifies empty
-- *strings* (nullif(v_row->>'price_at_signup', '')::numeric), so that literal
-- 0 sailed straight into subscriptions.price_at_signup as if it were a real,
-- known price. My Subscriptions (and Finance Export's price_paid column,
-- and the SuiteKey/team spend "actual" ledger) then treat 0 as "known,
-- free" rather than "unknown" and render/accrue it as $0.
--
-- Confirmed every affected row is a false zero, not a real free legacy
-- signup: every subscription imported with legacy_id set and
-- price_at_signup = 0 belongs to a license whose price is non-zero today
-- (checked directly — 1,496 rows, 0 of them pointing at a $0 license).
-- Non-legacy $0 rows (department-approved licenses like Gemini, priced $0
-- in the catalog) are untouched by this — those are genuinely free.
--
-- Fix: set price_at_signup back to null (unknown) for exactly this set, so
-- these subscriptions stop claiming a price that was never actually
-- recorded. Reversible in principle (the affected id set is re-derivable
-- from legacy_id is not null and price_at_signup = 0), but the true
-- historical price is not recoverable — it was never captured anywhere.
--
-- Run the SELECT first to see exactly what this will touch.

select s.id, s.user_email, s.legacy_id, s.status, s.fy, l.name, l.price as current_license_price
from subscriptions s
join licenses l on l.id = s.license_id
where s.legacy_id is not null and s.price_at_signup = 0
order by s.user_email;

update subscriptions
set price_at_signup = null
where legacy_id is not null and price_at_signup = 0;

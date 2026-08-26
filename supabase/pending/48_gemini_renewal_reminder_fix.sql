-- Run this in the Supabase SQL Editor.
--
-- Gemini's catalog entry (see 40_department_gated_licenses.sql) was created
-- with Admin -> Catalog's form default of billing_cycle='annual' and
-- renewal_reminder=true (Catalog.jsx's EMPTY_LICENSE), which
-- request_subscription() snapshots onto every subscription row at request
-- time. Gemini is free and department-gated, with no real annual cost to
-- renew, so its already-active subscriptions have no business surfacing
-- "Send renewal reminder" in Admin -> All Subscriptions
-- (isRenewalReminderEligible() only checks billing_cycle/renewal_reminder,
-- not billing_type). Flipping the toggle off in Catalog only changes what
-- future requests snapshot — this clears the flag already stored on
-- existing rows.
--
-- Run the select first to confirm which rows would be touched before
-- running the update.

select s.id, s.user_email, s.status, s.renewal_status
from subscriptions s
join licenses l on l.id = s.license_id
where l.name = 'Gemini'
  and s.renewal_reminder = true;

update subscriptions s
set renewal_reminder = false
from licenses l
where s.license_id = l.id
  and l.name = 'Gemini'
  and s.renewal_reminder = true;

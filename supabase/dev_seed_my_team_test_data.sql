-- OPTIONAL — testing helper only, not part of the pending/ migration
-- sequence. Nothing in the app requires this to be run.
--
-- My Team (src/pages/MyTeam.jsx) is driven entirely by profiles.manager_email
-- — get_report_emails() walks that column to find your direct + indirect
-- reports, then shows their non-cancelled subscriptions. Since the real org
-- hierarchy hasn't been imported yet (see the "pull full staff hierarchy"
-- item), there's currently no profile with manager_email set to anyone,
-- which is exactly why the page looks empty — there's nothing wrong with it,
-- there's just no data yet to prove it works.
--
-- Run the SELECT below first to find a real profile to borrow for the test:

select id, primary_email, manager_email from profiles order by primary_email;

-- Then fill in a real primary_email from that list (ideally an alias/test
-- account of your own, not a coworker's — you're about to give it a fake
-- subscription) and run the rest:

-- 1. Make that profile report to you.
update profiles
set manager_email = 'kate_brenner@sil.org'
where primary_email = 'REPLACE_WITH_A_REAL_PROFILE_EMAIL';

-- 2. Give it one active subscription so My Team has something to show.
-- Uses billing_type 'gtis' so it doesn't need a real suite_key or ministry_id.
insert into subscriptions (user_email, license_id, billing_type, fy, status)
select 'REPLACE_WITH_A_REAL_PROFILE_EMAIL', id, 'gtis', extract(year from now())::int, 'active'
from licenses
limit 1;

-- To undo once you've confirmed My Team shows the row:

-- delete from subscriptions where user_email = 'REPLACE_WITH_A_REAL_PROFILE_EMAIL' and billing_type = 'gtis';
-- update profiles set manager_email = null where primary_email = 'REPLACE_WITH_A_REAL_PROFILE_EMAIL';

-- Drops the 7-arg request_subscription() overload left behind by 41. 49 added
-- p_extra_field_value without dropping it (CREATE OR REPLACE only replaces an
-- identical argument list), and 59 only dropped 49's 8-arg version — so the
-- 7-arg and current 9-arg versions have coexisted since. Any request naming
-- only the original 7 params (e.g. a stale cached frontend bundle) matches
-- both, and PostgREST refuses with "Could not choose the best candidate
-- function". The current client always sends all 9 params; nothing else calls
-- the 7-arg version.
drop function if exists request_subscription(uuid, text, text, text, int, text, boolean);

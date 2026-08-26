-- Marks a SuiteKey as no longer in use. Date instead of boolean so we keep
-- a record of *when* it was deprecated, not just that it was.

alter table suite_keys add column if not exists deprecated_at date;

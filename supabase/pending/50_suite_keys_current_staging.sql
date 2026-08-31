-- Daily snapshot of currently-valid SuiteKeys, pulled from the finance
-- system by a Pipedream workflow that truncates and repopulates this table
-- every day (delete + insert, not upsert — a key missing from a day's pull
-- must disappear from here even though it stays in suite_keys until the
-- reconciliation step below deprecates it).
--
-- suite_keys itself is the durable, admin-owned record (owner_email,
-- owner_group_email, description, deprecated_at) and is NOT overwritten by
-- the daily pull. This table is only a comparison snapshot: which keys does
-- the source system currently consider valid. Reconciling the two — adding
-- suite_keys rows for keys new here, stamping deprecated_at on suite_keys
-- rows missing from here — is the next step, not yet built.
create table if not exists suite_keys_current (
  suite_key   text primary key,
  ou_code     text,
  cost_center text,
  synced_at   timestamptz not null default now()
);

alter table suite_keys_current enable row level security;

drop policy if exists "suite_keys_current: admin read" on suite_keys_current;
create policy "suite_keys_current: admin read" on suite_keys_current for select
  using (is_admin());
-- No client write policy — only the Pipedream sync (service-role key) writes here.

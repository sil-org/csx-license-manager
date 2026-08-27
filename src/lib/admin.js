import { supabase } from './supabase'

export async function getAuditLog({ suiteKey, limit = 200 } = {}) {
  let query = supabase
    .from('audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (suiteKey) query = query.eq('suite_key', suiteKey)

  const { data, error } = await query
  if (error) throw error
  return data
}

// Admin-only. RLS lets an admin read every suite_keys row directly, so no RPC
// needed for the list itself; "pending" status is computed by cross-referencing
// subscriptions still awaiting verification (admins can read all of those too).
// Also surfaces the suggested approver's email for pending keys, so the admin
// page can offer a one-click "confirm on their behalf" action — for the real-
// world case where the actual owner replies "yes, that's my key" outside the
// app (email, verbally) instead of completing the self-service confirm flow.
export async function getSuiteKeys() {
  const [{ data: keys, error: keysError }, { data: pending, error: pendingError }] = await Promise.all([
    supabase.from('suite_keys').select('*').order('suite_key'),
    supabase.from('subscriptions').select('suite_key, pending_approver_email').eq('status', 'pending_sk_verification'),
  ])
  if (keysError) throw keysError
  if (pendingError) throw pendingError

  // If multiple pending requests on the same key ever end up with different
  // suggested approvers, this just picks one — the admin confirm button is a
  // convenience for the normal case, not a substitute for the edit modal.
  const pendingApproverByKey = new Map((pending || []).map(s => [s.suite_key, s.pending_approver_email]))
  return (keys || []).map(k => ({
    ...k,
    status: pendingApproverByKey.has(k.suite_key) ? 'pending' : (k.owner_email || k.owner_group_email) ? 'confirmed' : 'unassigned',
    pendingApproverEmail: pendingApproverByKey.get(k.suite_key) || null,
  }))
}

// Returns the subscriptions re-pointed/advanced by the new owner (id, user_email,
// license_name) so the caller can notify them — see src/lib/email.js. Exactly one
// of newOwnerEmail / ownerGroupEmail should be set (mutually exclusive); pass
// neither to unassign.
export async function updateSuiteKeyOwner({ suiteKey, newOwnerEmail, description, ownerGroupEmail }) {
  const { data, error } = await supabase.rpc('admin_update_suite_key_owner', {
    p_suite_key: suiteKey,
    p_new_owner_email: newOwnerEmail || null,
    p_description: description || null,
    p_owner_group_email: ownerGroupEmail || null,
  })
  if (error) throw error
  return data
}

// For the "Confirm as {suggested approver}" quick-confirm button — behaves
// like the person themselves calling confirm_sk_ownership(), just triggered
// by an admin on their behalf. NOT the same as updateSuiteKeyOwner() above:
// this actually advances matching subscriptions out of pending_sk_verification.
export async function confirmSuiteKeyOwnership({ suiteKey, ownerEmail }) {
  const { data, error } = await supabase.rpc('admin_confirm_sk_ownership', {
    p_suite_key: suiteKey,
    p_owner_email: ownerEmail,
  })
  if (error) throw error
  return data
}

// For data-entry typos ("Relations-U_SIL~5407" instead of "Relations-U_SIL")
// — repoints every subscription off the bad key onto the correct one, then
// deletes the bad row. Refuses (server-side) if the bad key has a real owner
// on file, since that's very unlikely to actually be a typo.
export async function mergeSuiteKey({ badKey, correctKey }) {
  const { error } = await supabase.rpc('admin_merge_suite_key', {
    p_bad_key: badKey,
    p_correct_key: correctKey,
  })
  if (error) throw error
}

// Admin-only. Same RLS shape as suite_keys — admins can read every row directly.
export async function getMinistryIds() {
  const { data, error } = await supabase.from('ministry_ids').select('*').order('email')
  if (error) throw error
  return data
}

// Passing an empty ministryId deletes the row (unassigns it) — mirrors updateMinistryId() in GAS.
export async function updateMinistryId({ email, ministryId }) {
  const { error } = await supabase.rpc('admin_update_ministry_id', {
    p_email: email,
    p_ministry_id: ministryId || null,
  })
  if (error) throw error
}

// Admin-only. Every subscription, every user — mirrors GAS's getAllSubscriptions().
// Relies on RLS (admins can already read every subscriptions/licenses row).
// Paginated like getFinanceExport() below: PostgREST caps a single response
// at 1000 rows, and this org has already blown past that — an unpaginated
// select here silently drops every subscription older than the newest 1000.
export async function getAllSubscriptions() {
  const pageSize = 1000
  const rows = []
  for (let offset = 0, total = null; total === null || offset < total; offset += pageSize) {
    const { data, count, error } = await supabase
      .from('subscriptions')
      .select('*, license:licenses(name, vendor, category, activation_url, onboarding_message, reminder_message, more_info_url, service_manager_emails, extra_field_label, extra_field_required)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1)
    if (error) throw error
    if (data.length === 0) break
    rows.push(...data)
    total = count
  }
  return rows
}

// Mirrors GAS's getFinanceExport()/_calcProRatedCost() — see calc_prorated_cost()
// in supabase/schema_licenses.sql for the actual pro-ration math.
// Paginated: PostgREST caps a single response at 1000 rows (Supabase's default
// max-rows setting), and get_finance_export() now returns every active
// subscription regardless of the date range, so orgs of any real size blow
// past that in one call — silently truncating the export with no error.
export async function getFinanceExport({ from, to }) {
  const pageSize = 1000
  const rows = []
  // Loop by exact total count rather than "got back fewer than pageSize" —
  // if the project's PostgREST max-rows setting is ever below pageSize, a
  // full page would look identical to a final partial one.
  for (let offset = 0, total = null; total === null || offset < total; offset += pageSize) {
    const { data, count, error } = await supabase
      .rpc('get_finance_export', { p_start_date: from, p_end_date: to }, { count: 'exact' })
      .range(offset, offset + pageSize - 1)
    if (error) throw error
    if (data.length === 0) break
    rows.push(...data)
    total = count
  }
  return rows
}

// Bulk-imports already-active subscriptions from a legacy/historical source.
// Returns one {ok, error?, row} result per input row — mirrors GAS's
// importSubscriptions(), which never let one bad row fail the whole batch.
export async function importSubscriptions(rows) {
  const { data, error } = await supabase.rpc('admin_import_subscriptions', { p_rows: rows })
  if (error) throw error
  return data || []
}

// One-time GAS historical backfill — see supabase/pending/17_gas_historical_import.sql.
// Run in order: licenses, then subscriptions, then audit log (each depends on
// the previous having been imported). Every row carries a `legacy_id` (the
// GAS sheet's own ID column) so re-running any of these is safe — an
// already-imported row is skipped, not duplicated or overwritten.
export async function importLicenses(rows) {
  const { data, error } = await supabase.rpc('admin_import_licenses', { p_rows: rows })
  if (error) throw error
  return data || []
}

export async function importSubscriptionsFull(rows) {
  const { data, error } = await supabase.rpc('admin_import_subscriptions_full', { p_rows: rows })
  if (error) throw error
  return data || []
}

export async function importAuditLog(rows) {
  const { data, error } = await supabase.rpc('admin_import_audit_log', { p_rows: rows })
  if (error) throw error
  return data || []
}

// Upserts profiles.manager_email from a weekly export of the org-hierarchy
// Sheet — see supabase/pending/32_team_hierarchy_import.sql for why this is
// a manual CSV import rather than a live pull.
export async function importTeamHierarchy(rows) {
  const { data, error } = await supabase.rpc('admin_import_team_hierarchy', { p_rows: rows })
  if (error) throw error
  return data || []
}

// Admin-only. Lists every profile (email, role) for the Admin Users page.
export async function getProfiles() {
  const { data, error } = await supabase.from('profiles').select('id, display_name, primary_email, role').order('primary_email')
  if (error) throw error
  return data
}

// The only sanctioned way to change a profile's role — see admin_set_role()
// and the fix to profiles' RLS in supabase/schema.sql for why this can't be
// done via a plain client-side update anymore.
export async function setProfileRole({ profileId, role }) {
  const { error } = await supabase.rpc('admin_set_role', { p_profile_id: profileId, p_role: role })
  if (error) throw error
}

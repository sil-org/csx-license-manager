import { supabase } from './supabase'

function applyAuditLogFilters(query, { userEmail, licenseName, action, suiteKey, dateFrom, dateTo } = {}) {
  if (userEmail) query = query.ilike('user_email', `%${userEmail}%`)
  if (licenseName) query = query.eq('license_name', licenseName)
  if (action) query = query.eq('action', action)
  if (suiteKey) query = query.ilike('suite_key', `%${suiteKey}%`)
  if (dateFrom) query = query.gte('created_at', dateFrom)
  if (dateTo) {
    // dateTo is a plain "YYYY-MM-DD" from a date input; treat it as inclusive
    // of the whole day by comparing against the start of the next day.
    const end = new Date(dateTo + 'T00:00:00')
    end.setDate(end.getDate() + 1)
    query = query.lt('created_at', end.toISOString())
  }
  return query
}

// Paginated for the admin Audit Log page. Filters mirror the preset searches
// offered there (user, license, action, suite key, date range) so the same
// builder backs both the on-screen page and the "export everything matching
// this filter" CSV below.
export async function getAuditLog({ page = 0, pageSize = 50, ...filters } = {}) {
  let query = supabase
    .from('audit_log')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
  query = applyAuditLogFilters(query, filters)

  const from = page * pageSize
  const { data, error, count } = await query.range(from, from + pageSize - 1)
  if (error) throw error
  return { rows: data, count }
}

// Fetches every row matching the filters, ignoring pagination — for CSV
// export. Paged internally in batches since PostgREST caps rows per request.
export async function getAuditLogForExport(filters = {}) {
  const batchSize = 1000
  let page = 0
  let all = []
  while (true) {
    let query = supabase
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
    query = applyAuditLogFilters(query, filters)

    const from = page * batchSize
    const { data, error } = await query.range(from, from + batchSize - 1)
    if (error) throw error
    all = all.concat(data)
    if (data.length < batchSize) break
    page++
  }
  return all
}

// Admin-only. RLS lets an admin read every suite_keys row directly, so no RPC
// needed for the list itself; "pending" status is computed by cross-referencing
// subscriptions still awaiting verification (admins can read all of those too),
// falling back to the key's own pending_owner_email when there's no such
// subscription — set by admin_update_subscription_suite_key() when an admin
// repoints a subscription onto an unclaimed key and supplies a suggested
// approver, which (unlike request_subscription()) never puts a subscription
// into pending_sk_verification. Also surfaces the suggested approver's email
// for pending keys, so the admin page can offer a one-click "confirm on their
// behalf" action — for the real-world case where the actual owner replies
// "yes, that's my key" outside the app (email, verbally) instead of
// completing the self-service confirm flow.
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
  return (keys || []).map(k => {
    const pendingApproverEmail = pendingApproverByKey.get(k.suite_key) || k.pending_owner_email || null
    return {
      ...k,
      status: pendingApproverEmail ? 'pending' : (k.owner_email || k.owner_group_email) ? 'confirmed' : 'unassigned',
      pendingApproverEmail,
    }
  })
}

// Returns the subscriptions re-pointed/advanced by the new owner (id, user_email,
// license_name) so the caller can notify them — see src/lib/email.js. Exactly one
// of newOwnerEmail / ownerGroupEmail should be set (mutually exclusive); pass
// neither to unassign.
export async function updateSuiteKeyOwner({ suiteKey, newOwnerEmail, ownerGroupEmail }) {
  const { data, error } = await supabase.rpc('admin_update_suite_key_owner', {
    p_suite_key: suiteKey,
    p_new_owner_email: newOwnerEmail || null,
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

// Shared shape for both getAllSubscriptions() and searchSubscriptions()
// below — no renewals embed: that was only ever fetched for All
// Subscriptions' now-removed Renewal column, and pulling every
// subscription's renewal history on every load (a to-many join, evaluated
// under RLS for every row) was a meaningful chunk of why loading this page
// took so long.
const SUBSCRIPTION_SELECT = '*, license:licenses(name, vendor, category, price, price_unit, activation_url, onboarding_message, reminder_message, more_info_url, service_manager_emails, extra_field_label, extra_field_required, provisioning_email_show_name, provisioning_email_show_job_title, provisioning_email_show_department), suite_key_row:suite_keys(deprecated_at)'

// Admin-only. Every subscription, every user — mirrors GAS's getAllSubscriptions().
// Relies on RLS (admins can already read every subscriptions/licenses row).
// Paginated like getFinanceExport() below: PostgREST caps a single response
// at 1000 rows, and this org has already blown past that — an unpaginated
// select here silently drops every subscription older than the newest 1000.
// Only used for All Subscriptions' explicit "Export all" button now — the
// on-screen table itself uses searchSubscriptions() instead, since loading
// and joining all 2,000+ rows just to render a page was the whole problem.
export async function getAllSubscriptions() {
  const pageSize = 1000
  const rows = []
  // Advance by data.length, not pageSize: if the project's PostgREST max-rows
  // setting is below pageSize, each request silently gets capped to fewer
  // rows than asked for — advancing by the nominal pageSize would then skip
  // straight past the un-fetched remainder of every page.
  for (let offset = 0, total = null; total === null || offset < total;) {
    const { data, count, error } = await supabase
      .from('subscriptions')
      .select(SUBSCRIPTION_SELECT, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1)
    if (error) throw error
    if (data.length === 0) break
    rows.push(...data)
    total = count
    offset += data.length
  }
  return rows
}

// Server-side search/filter for Admin -> All Subscriptions, replacing the
// old "load every subscription, filter client-side" approach — that meant
// opening the page always paid for every row's RLS checks and joins before
// the admin had even typed anything. Returns nothing until search/status/
// license/fy actually narrows the query; capped at pageSize (the UI shows a
// "narrow your search" hint rather than paging through everything, since an
// admin hunting for a specific subscription rarely needs more than that).
//
// license name can't be searched inline via .or() (it lives on the joined
// licenses table, and PostgREST's .or() only reaches the base table's own
// columns) — so a name match is resolved to license ids first and folded
// into the same .or() as an `in` clause. status is deliberately left out of
// free-text search: it's a Postgres enum, and enums don't support ilike —
// the dedicated status dropdown already covers exact-match status filtering.
export async function searchSubscriptions({ search = '', status = '', licenseId = '', fy = '', page = 0, pageSize = 200 } = {}) {
  let query = supabase
    .from('subscriptions')
    .select(SUBSCRIPTION_SELECT, { count: 'exact' })
    .order('created_at', { ascending: false })

  const q = search.trim()
  if (q) {
    // Commas/parens are .or()'s own clause delimiters — escape them so a
    // search containing one can't be misread as extra filter clauses.
    const escaped = q.replace(/[,()]/g, '\\$&')
    const clauses = [`user_email.ilike.%${escaped}%`, `suite_key.ilike.%${escaped}%`, `ministry_id.ilike.%${escaped}%`]

    const { data: matchedLicenses, error: licenseError } = await supabase.from('licenses').select('id').ilike('name', `%${q}%`)
    if (licenseError) throw licenseError
    if (matchedLicenses.length) clauses.push(`license_id.in.(${matchedLicenses.map(l => l.id).join(',')})`)

    query = query.or(clauses.join(','))
  }
  if (status) query = query.eq('status', status)
  if (licenseId) query = query.eq('license_id', licenseId)
  if (fy) query = query.eq('fy', Number(fy))

  const from = page * pageSize
  const { data, error, count } = await query.range(from, from + pageSize - 1)
  if (error) throw error
  return { rows: data, count }
}

// License dropdown options for the search filters above — every license's
// id/name. There's no longer a full subscriptions list loaded to derive
// "licenses actually in use" from, so this just lists the catalog; licenses
// is public-readable so this needs no special authority.
export async function getLicenseOptions() {
  const { data, error } = await supabase.from('licenses').select('id, name').order('name')
  if (error) throw error
  return data || []
}

// FY dropdown options. Still touches every subscription row (RLS-scoped,
// same as before), but only the fy column — no joins — so it stays cheap.
export async function getSubscriptionFyOptions() {
  const { data, error } = await supabase.from('subscriptions').select('fy')
  if (error) throw error
  return [...new Set((data || []).map(r => r.fy).filter(fy => fy != null))].sort((a, b) => b - a)
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
  // Advance by data.length, not pageSize: if the project's PostgREST max-rows
  // setting is ever below pageSize, a full page would look identical to a
  // final partial one, and advancing by the nominal pageSize would skip
  // straight past the un-fetched remainder of every page.
  for (let offset = 0, total = null; total === null || offset < total;) {
    const { data, count, error } = await supabase
      .rpc('get_finance_export', { p_start_date: from, p_end_date: to }, { count: 'exact' })
      .range(offset, offset + pageSize - 1)
    if (error) throw error
    if (data.length === 0) break
    rows.push(...data)
    total = count
    offset += data.length
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

// Upserts the sco -> department-name lookup (sco_codes) from an export of
// the org-structure Sheet — see supabase/pending/60_sco_codes.sql. Changes
// far less often than team hierarchy, but same upsert-only shape.
export async function importScoCodes(rows) {
  const { data, error } = await supabase.rpc('admin_import_sco_codes', { p_rows: rows })
  if (error) throw error
  return data || []
}

// Admin-only. Lists every profile (email, role) for the Admin Users page.
// Paginated like getAllSubscriptions()/getFinanceExport() above: PostgREST
// caps a single response at 1000 rows, and profiles is ordered by email, so
// an unpaginated select here would silently drop everyone alphabetically
// past the cutoff.
export async function getProfiles() {
  const pageSize = 1000
  const rows = []
  // Advance by data.length, not pageSize — see getAllSubscriptions() above.
  for (let offset = 0, total = null; total === null || offset < total;) {
    const { data, count, error } = await supabase
      .from('profiles')
      .select('id, display_name, primary_email, role', { count: 'exact' })
      .order('primary_email')
      .range(offset, offset + pageSize - 1)
    if (error) throw error
    if (data.length === 0) break
    rows.push(...data)
    total = count
    offset += data.length
  }
  return rows
}

// The only sanctioned way to change a profile's role — see admin_set_role()
// and the fix to profiles' RLS in supabase/schema.sql for why this can't be
// done via a plain client-side update anymore.
export async function setProfileRole({ profileId, role }) {
  const { error } = await supabase.rpc('admin_set_role', { p_profile_id: profileId, p_role: role })
  if (error) throw error
}

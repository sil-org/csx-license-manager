import { supabase } from './supabase'

// Mirrors Managers.gs's getTeamSubscriptions(): direct + indirect reports'
// subscriptions, every status included — the page itself hides
// cancelled/declined/revoked by default (see MyTeam.jsx's hideInactive), same
// as My Subscriptions. Not role-gated — same "just show it, it's empty if
// nothing applies" convention as Action Center — since whether someone has
// reports is derived from profiles.manager_email, not a stored role.
//
// currentUserEmail (the caller's own profile.primary_email, passed in by
// MyTeam.jsx) is folded into the same result once we know they're actually a
// manager — someone reviewing their team's licenses generally wants to see
// their own alongside them. Only added once reportEmails is non-empty: a
// non-manager with no reports still sees nothing, same as before.
export async function getTeamSubscriptions(currentUserEmail) {
  const { data: rows, error: reportsError } = await supabase.rpc('get_report_emails')
  if (reportsError) throw reportsError
  // PostgREST returns a `setof text` RPC as a bare array of strings — this
  // handles it either way in case that ever changes.
  const reportEmails = (rows || []).map(r => (typeof r === 'string' ? r : r.get_report_emails))
  if (!reportEmails.length) return []

  const emails = currentUserEmail ? [...reportEmails, currentUserEmail] : reportEmails

  const { data, error } = await supabase
    .from('subscriptions')
    .select('*, license:licenses(name, vendor, category)')
    .in('user_email', emails)
    .order('user_email')
  if (error) throw error
  return data
}

// Per-billing-type spend totals (suite_key / ministry / gtis) for the
// caller's own + reports' subscriptions in one fiscal year — see
// get_team_spend() in supabase/pending/70_team_spend.sql for how `actual`
// (exact, from price_at_signup + decided renewals) and `projected` (not-yet-
// decided renewals estimated at current price + 10%) are computed. Returns
// one row per category, both always present even when $0, so callers don't
// need to guess which categories exist.
export async function getTeamSpend(fiscalYear) {
  const { data, error } = await supabase.rpc('get_team_spend', { p_fiscal_year: fiscalYear })
  if (error) throw error
  const byType = Object.fromEntries((data || []).map(r => [r.billing_type, r]))
  return {
    suiteKey: byType.suite_key || { actual: 0, projected: 0 },
    ministry: byType.ministry || { actual: 0, projected: 0 },
    gtis: byType.gtis || { actual: 0, projected: 0 },
  }
}

// When the org-hierarchy CSV (profiles.manager_email) was last imported —
// see supabase/pending/32_team_hierarchy_import.sql. Not admin-gated: the
// timestamp/count aren't sensitive, and My Team itself isn't role-gated either.
export async function getLastTeamImport() {
  const { data, error } = await supabase.rpc('get_last_team_import')
  if (error) throw error
  return data?.[0] || null
}

import { supabase } from './supabase'

// Mirrors Managers.gs's getTeamSubscriptions(): direct + indirect reports'
// subscriptions, every status included — the page itself hides
// cancelled/declined/revoked by default (see MyTeam.jsx's hideInactive), same
// as My Subscriptions. Not role-gated — same "just show it, it's empty if
// nothing applies" convention as Action Center — since whether someone has
// reports is derived from profiles.manager_email, not a stored role.
export async function getTeamSubscriptions() {
  const { data: rows, error: reportsError } = await supabase.rpc('get_report_emails')
  if (reportsError) throw reportsError
  // PostgREST returns a `setof text` RPC as a bare array of strings — this
  // handles it either way in case that ever changes.
  const reportEmails = (rows || []).map(r => (typeof r === 'string' ? r : r.get_report_emails))
  if (!reportEmails.length) return []

  const { data, error } = await supabase
    .from('subscriptions')
    .select('*, license:licenses(name, vendor, category)')
    .in('user_email', reportEmails)
    .order('user_email')
  if (error) throw error
  return data
}

// When the org-hierarchy CSV (profiles.manager_email) was last imported —
// see supabase/pending/32_team_hierarchy_import.sql. Not admin-gated: the
// timestamp/count aren't sensitive, and My Team itself isn't role-gated either.
export async function getLastTeamImport() {
  const { data, error } = await supabase.rpc('get_last_team_import')
  if (error) throw error
  return data?.[0] || null
}

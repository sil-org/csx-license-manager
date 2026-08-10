import { supabase } from './supabase'

// Mirrors Managers.gs's getTeamSubscriptions(): direct + indirect reports'
// non-cancelled subscriptions. Not role-gated — same "just show it, it's
// empty if nothing applies" convention as Action Center — since whether someone
// has reports is derived from profiles.manager_email, not a stored role.
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
    .neq('status', 'cancelled')
    .order('user_email')
  if (error) throw error
  return data
}

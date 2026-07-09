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
export async function getSuiteKeys() {
  const [{ data: keys, error: keysError }, { data: pending, error: pendingError }] = await Promise.all([
    supabase.from('suite_keys').select('*').order('suite_key'),
    supabase.from('subscriptions').select('suite_key').eq('status', 'pending_sk_verification'),
  ])
  if (keysError) throw keysError
  if (pendingError) throw pendingError

  const pendingKeys = new Set((pending || []).map(s => s.suite_key))
  return (keys || []).map(k => ({
    ...k,
    status: pendingKeys.has(k.suite_key) ? 'pending' : k.owner_email ? 'confirmed' : 'unassigned',
  }))
}

// Returns the subscriptions re-pointed to the new owner (id, user_email, license_name)
// so the caller can notify them — see src/lib/email.js.
export async function updateSuiteKeyOwner({ suiteKey, newOwnerEmail, description }) {
  const { data, error } = await supabase.rpc('admin_update_suite_key_owner', {
    p_suite_key: suiteKey,
    p_new_owner_email: newOwnerEmail || null,
    p_description: description || null,
  })
  if (error) throw error
  return data
}

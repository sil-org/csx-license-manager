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

import { supabase } from './supabase'
import { buildProvisioningNotifications, SUB_EMAIL_FIELDS } from './subscriptions'

// Everything a suite-key owner or service manager might need to act on —
// backs the Action Center page (src/pages/ActionCenter.jsx). RLS already
// scopes these selects to rows the caller is authorized to see.

// Scoped to what the caller can personally act on next — see
// get_my_pending_sk_verifications()/get_my_pending_approvals() in
// supabase/pending/19_scope_approvals_to_owned_keys.sql for why this isn't
// a plain table select (RLS's own admin bypass would show every pending
// row company-wide instead of just the caller's own).

export async function getPendingSkVerifications() {
  const { data, error } = await supabase.rpc('get_my_pending_sk_verifications')
  if (error) throw error
  return data
}

export async function getPendingApprovals() {
  const { data, error } = await supabase.rpc('get_my_pending_approvals')
  if (error) throw error
  return data
}

// Both return the subscriptions they just advanced ({id, user_email, license_name}[])
// so the caller can notify each one — see src/lib/email.js.

export async function confirmSkOwnership(suiteKey) {
  const { data, error } = await supabase.rpc('confirm_sk_ownership', { p_suite_key: suiteKey })
  if (error) throw error
  return data
}

export async function denySkOwnership(suiteKey) {
  const { data, error } = await supabase.rpc('deny_sk_ownership', { p_suite_key: suiteKey })
  if (error) throw error
  return data
}

// Returns an array of { type, to, ... } entries — either the provisioning-needed
// pair (see buildProvisioningNotifications) or a single 'decision_approved'
// entry when the subscription went straight to 'active'. See handleApprove()
// in ActionCenter.jsx.
export async function approveSubscription(subscriptionId) {
  const { error } = await supabase.rpc('approve_subscription', { p_subscription_id: subscriptionId })
  if (error) throw error

  const { data: sub, error: subError } = await supabase
    .from('subscriptions')
    .select(`status, ${SUB_EMAIL_FIELDS}`)
    .eq('id', subscriptionId)
    .single()
  if (subError) throw subError

  if (sub.status === 'approved') return buildProvisioningNotifications(sub)
  return [{ type: 'decision_approved', to: sub.user_email, sub, licenseName: sub.license.name }]
}

// Returns [{ type: 'declined', to, sub, licenseName, reason }] for the caller
// to email — see handleDecline() in ActionCenter.jsx.
export async function declineSubscription(subscriptionId, notes) {
  const { error } = await supabase.rpc('decline_subscription', { p_subscription_id: subscriptionId, p_notes: notes || null })
  if (error) throw error

  const { data: sub, error: subError } = await supabase
    .from('subscriptions')
    .select(SUB_EMAIL_FIELDS)
    .eq('id', subscriptionId)
    .single()
  if (subError) throw subError

  return [{ type: 'declined', to: sub.user_email, sub, licenseName: sub.license.name, reason: notes || null }]
}

export async function activateSubscription(subscriptionId, price) {
  const { error } = await supabase.rpc('activate_subscription', { p_subscription_id: subscriptionId, p_price: price ?? null })
  if (error) throw error
}

// Returns [{ type: 'revoked', to, sub, licenseName }] for the caller to email.
export async function revokeSubscription(subscriptionId) {
  const { error } = await supabase.rpc('revoke_subscription', { p_subscription_id: subscriptionId })
  if (error) throw error

  const { data: sub, error: subError } = await supabase
    .from('subscriptions')
    .select(SUB_EMAIL_FIELDS)
    .eq('id', subscriptionId)
    .single()
  if (subError) throw subError

  return [{ type: 'revoked', to: sub.user_email, sub, licenseName: sub.license.name }]
}

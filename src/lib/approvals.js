import { supabase } from './supabase'
import { buildProvisioningNotifications } from './subscriptions'

// Everything a suite-key owner or service manager might need to act on.
// RLS already scopes these selects to rows the caller is authorized to see.

export async function getPendingSkVerifications() {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*, license:licenses(name)')
    .eq('status', 'pending_sk_verification')
    .order('created_at')
  if (error) throw error
  return data
}

export async function getPendingApprovals() {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*, license:licenses(name, activation_url)')
    .eq('status', 'pending')
    .order('created_at')
  if (error) throw error
  return data
}

export async function getProvisioningQueue() {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*, license:licenses(name, activation_url, service_manager_email, onboarding_message)')
    .eq('status', 'approved')
    .order('created_at')
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

const SUB_EMAIL_FIELDS = 'user_email, fy, billing_cycle, billing_type, suite_key, ministry_id, license:licenses(name, activation_url, service_manager_email)'

// Returns an array of { type, to, ... } entries — either the provisioning-needed
// pair (see buildProvisioningNotifications) or a single 'decision_approved'
// entry when the subscription went straight to 'active'. See handleApprove()
// in Approvals.jsx.
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
// to email — see handleDecline() in Approvals.jsx.
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

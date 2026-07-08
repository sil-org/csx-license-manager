import { supabase } from './supabase'

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
    .select('*, license:licenses(name, activation_url, service_manager_email)')
    .eq('status', 'approved')
    .order('created_at')
  if (error) throw error
  return data
}

export async function confirmSkOwnership(suiteKey) {
  const { error } = await supabase.rpc('confirm_sk_ownership', { p_suite_key: suiteKey })
  if (error) throw error
}

export async function denySkOwnership(suiteKey) {
  const { error } = await supabase.rpc('deny_sk_ownership', { p_suite_key: suiteKey })
  if (error) throw error
}

export async function approveSubscription(subscriptionId) {
  const { error } = await supabase.rpc('approve_subscription', { p_subscription_id: subscriptionId })
  if (error) throw error
}

export async function declineSubscription(subscriptionId, notes) {
  const { error } = await supabase.rpc('decline_subscription', { p_subscription_id: subscriptionId, p_notes: notes || null })
  if (error) throw error
}

export async function activateSubscription(subscriptionId, price) {
  const { error } = await supabase.rpc('activate_subscription', { p_subscription_id: subscriptionId, p_price: price ?? null })
  if (error) throw error
}

export async function revokeSubscription(subscriptionId) {
  const { error } = await supabase.rpc('revoke_subscription', { p_subscription_id: subscriptionId })
  if (error) throw error
}

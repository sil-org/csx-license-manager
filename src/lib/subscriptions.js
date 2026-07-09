import { supabase } from './supabase'

export async function getMySubscriptions(email) {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*, license:licenses(name, vendor, category, logo_url)')
    .eq('user_email', email)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

// Returns { id, status, notify } — notify is null unless someone needs to be
// emailed as a result (see src/lib/email.js), in which case it's
// { type: 'sk_verification' | 'approval_request', to: email }.
export async function requestSubscription({ licenseId, suiteKey, suggestedApproverEmail, ministryId, fy }) {
  const { data: id, error } = await supabase.rpc('request_subscription', {
    p_license_id: licenseId,
    p_suite_key: suiteKey || null,
    p_suggested_approver_email: suggestedApproverEmail || null,
    p_ministry_id: ministryId || null,
    p_fy: fy,
  })
  if (error) throw error

  const { data: sub, error: subError } = await supabase
    .from('subscriptions')
    .select('status, suite_key, pending_approver_email')
    .eq('id', id)
    .single()
  if (subError) throw subError

  let notify = null
  if (sub.status === 'pending_sk_verification' && sub.pending_approver_email) {
    notify = { type: 'sk_verification', to: sub.pending_approver_email }
  } else if (sub.status === 'pending' && sub.suite_key) {
    // Direct select would fail here — suite_keys' RLS only allows reading rows
    // you own (or as admin), and the requester is neither. get_suite_key_owner()
    // is a narrow RPC that answers just this one question regardless.
    const { data: ownerEmail } = await supabase.rpc('get_suite_key_owner', { p_suite_key: sub.suite_key })
    if (ownerEmail) notify = { type: 'approval_request', to: ownerEmail }
  }

  return { id, status: sub.status, notify }
}

export async function cancelSubscription(subscriptionId) {
  const { error } = await supabase.rpc('cancel_subscription', { p_subscription_id: subscriptionId })
  if (error) throw error
}

export async function optInRenewal(subscriptionId) {
  const { error } = await supabase.rpc('opt_in_renewal', { p_subscription_id: subscriptionId })
  if (error) throw error
}

export async function optOutRenewal(subscriptionId) {
  const { error } = await supabase.rpc('opt_out_renewal', { p_subscription_id: subscriptionId })
  if (error) throw error
}

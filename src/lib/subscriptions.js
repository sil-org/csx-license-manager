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
    const { data: sk } = await supabase.from('suite_keys').select('owner_email').eq('suite_key', sub.suite_key).single()
    if (sk?.owner_email) notify = { type: 'approval_request', to: sk.owner_email }
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

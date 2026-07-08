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

export async function requestSubscription({ licenseId, suiteKey, suggestedApproverEmail, ministryId, fy }) {
  const { data, error } = await supabase.rpc('request_subscription', {
    p_license_id: licenseId,
    p_suite_key: suiteKey || null,
    p_suggested_approver_email: suggestedApproverEmail || null,
    p_ministry_id: ministryId || null,
    p_fy: fy,
  })
  if (error) throw error
  return data
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

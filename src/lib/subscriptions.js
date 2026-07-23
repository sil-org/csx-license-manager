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

// Both request_subscription and approve_subscription (src/lib/approvals.js)
// can land a subscription straight in 'approved' (auto-approved or manually
// approved, but the license needs provisioning before it's active) — same
// two emails either way: tell the requester setup is in progress, and tell
// whoever needs to provision the seat. Exported so approve_subscription can
// reuse it instead of duplicating the recipient-fallback logic.
export async function buildProvisioningNotifications(sub) {
  const notifications = [{ type: 'approved_pending', to: sub.user_email, sub, licenseName: sub.license.name }]

  let recipients = sub.license.service_manager_email ? [sub.license.service_manager_email] : []
  if (!recipients.length) {
    const { data } = await supabase.rpc('get_admin_emails')
    recipients = data || []
  }
  // send-email only accepts a single address per call (and logs one email_log
  // row per send) — one notification per recipient rather than joining into
  // a comma-separated `to`, which Resend wouldn't treat as multiple addresses.
  for (const to of recipients) {
    notifications.push({
      type: 'provisioning_required', to, sub,
      licenseName: sub.license.name, activationUrl: sub.license.activation_url,
    })
  }
  return notifications
}

// Returns { id, status, notify } — notify is null unless someone needs to be
// emailed as a result, otherwise an array of { type, to, ... } entries (see
// notifyForRequest() in src/pages/Catalog.jsx, which dispatches on type).
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
    .select('status, suite_key, pending_approver_email, user_email, fy, billing_cycle, billing_type, ministry_id, license:licenses(name, activation_url, service_manager_email)')
    .eq('id', id)
    .single()
  if (subError) throw subError

  let notify = null
  if (sub.status === 'pending_sk_verification' && sub.pending_approver_email) {
    notify = [{ type: 'sk_verification', to: sub.pending_approver_email }]
  } else if (sub.status === 'pending' && sub.suite_key) {
    // Direct select would fail here — suite_keys' RLS only allows reading rows
    // you own (or as admin), and the requester is neither. get_suite_key_owner()
    // is a narrow RPC that answers just this one question regardless. Returns
    // one row (or none); a group-owned key has no individual to email, so the
    // notification goes to the group address itself — Workspace fans it out.
    const { data } = await supabase.rpc('get_suite_key_owner', { p_suite_key: sub.suite_key })
    const owner = data?.[0]
    const to = owner?.owner_group_email || owner?.owner_email
    if (to) notify = [{ type: 'approval_request', to }]
  } else if (sub.status === 'approved') {
    notify = await buildProvisioningNotifications(sub)
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

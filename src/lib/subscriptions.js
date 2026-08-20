import { supabase } from './supabase'

export async function getAdminEmails() {
  const { data } = await supabase.rpc('get_admin_emails')
  return data || []
}

// RLS-bypassing lookup (get_seat_provisioning_fields RPC) — profiles' "own
// read" policy means a non-admin service manager can't otherwise see the
// seat user's name/job title/department. Falls back to nulls (email-only)
// if the profile has none of these on file.
async function getSeatProvisioningFields(email) {
  const { data } = await supabase.rpc('get_seat_provisioning_fields', { p_email: email })
  return data?.[0] || { display_name: null, job_title: null, department: null }
}

export async function getMySubscriptions(email) {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*, license:licenses(name, vendor, category, logo_url, price_unit)')
    .eq('user_email', email)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

// Shared re-select shape for RPCs (here and in lib/approvals.js) that need to
// build a notification descriptor after a status-changing RPC call.
export const SUB_EMAIL_FIELDS = 'user_email, fy, billing_cycle, billing_type, suite_key, ministry_id, license:licenses(name, activation_url, service_manager_emails, provisioning_email_show_name, provisioning_email_show_job_title, provisioning_email_show_department)'

// Both request_subscription and approve_subscription (src/lib/approvals.js)
// can land a subscription straight in 'approved' (auto-approved or manually
// approved, but the license needs provisioning before it's active) — same
// two emails either way: tell the requester setup is in progress, and tell
// whoever needs to provision the seat. Exported so approve_subscription can
// reuse it instead of duplicating the recipient-fallback logic.
export async function buildProvisioningNotifications(sub) {
  const notifications = [{ type: 'approved_pending', to: sub.user_email, sub, licenseName: sub.license.name }]

  let recipients = sub.license.service_manager_emails?.length ? sub.license.service_manager_emails : []
  if (!recipients.length) {
    recipients = await getAdminEmails()
  }
  // One email with every recipient in the To field, not one send per
  // recipient — send-email/Resend accepts an array for `to`.
  if (recipients.length) {
    const { display_name: userDisplayName, job_title: jobTitle, department } = await getSeatProvisioningFields(sub.user_email)
    notifications.push({
      type: 'provisioning_required', to: recipients, sub,
      licenseName: sub.license.name, activationUrl: sub.license.activation_url,
      userDisplayName, jobTitle, department,
      showName: sub.license.provisioning_email_show_name,
      showJobTitle: sub.license.provisioning_email_show_job_title,
      showDepartment: sub.license.provisioning_email_show_department,
    })
  }
  return notifications
}

// Returns { id, status, notify } — notify is null unless someone needs to be
// emailed as a result, otherwise an array of { type, to, ... } entries (see
// notifyForRequest() in src/pages/Catalog.jsx, which dispatches on type).
export async function requestSubscription({ licenseId, suiteKey, suggestedApproverEmail, ministryId, fy, recipientEmail, acknowledged }) {
  const { data: id, error } = await supabase.rpc('request_subscription', {
    p_license_id: licenseId,
    p_suite_key: suiteKey || null,
    p_suggested_approver_email: suggestedApproverEmail || null,
    p_ministry_id: ministryId || null,
    p_fy: fy,
    p_recipient_email: recipientEmail || null,
    p_acknowledged: !!acknowledged,
  })
  if (error) throw error

  const { data: sub, error: subError } = await supabase
    .from('subscriptions')
    .select('status, suite_key, pending_approver_email, user_email, fy, billing_cycle, billing_type, ministry_id, license:licenses(name, activation_url, service_manager_emails, provisioning_email_show_name, provisioning_email_show_job_title, provisioning_email_show_department)')
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
  } else if (sub.status === 'pending' && sub.billing_type === 'department' && sub.pending_approver_email) {
    notify = [{ type: 'department_approval_request', to: sub.pending_approver_email }]
  } else if (sub.status === 'approved') {
    notify = await buildProvisioningNotifications(sub)
  }

  return { id, status: sub.status, notify }
}

// Re-sends the 'approval_request' owner email for an already-pending
// subscription — use when the original request-time notification never went
// out (e.g. the requester's session couldn't read back the row they'd just
// created to figure out who to email — see request-for-others RLS gap).
// Admin callers already have full row access, so this only needs the owner
// lookup and the original requester's email off the audit trail.
export async function resendApprovalRequest(sub) {
  const { data: ownerRows } = await supabase.rpc('get_suite_key_owner', { p_suite_key: sub.suite_key })
  const owner = ownerRows?.[0]
  const to = owner?.owner_group_email || owner?.owner_email
  if (!to) return null

  const { data: auditRows } = await supabase
    .from('audit_log')
    .select('performed_by')
    .eq('subscription_id', sub.id)
    .eq('action', 'requested')
    .order('created_at', { ascending: false })
    .limit(1)
  const requesterEmail = auditRows?.[0]?.performed_by || sub.user_email

  return {
    type: 'approval_request', to, suiteKey: sub.suite_key,
    licenseName: sub.license?.name, requesterEmail, recipientEmail: sub.user_email,
    moreInfoUrl: sub.license?.more_info_url,
  }
}

// Re-sends the "someone needs to provision this" notification for an
// already-'approved' subscription — same service-manager-or-admins routing
// as the original request-time email (buildProvisioningNotifications
// above), minus the 'approved_pending' copy to the requester, who already
// knows their subscription is pending setup.
export async function resendProvisioningRequest(sub) {
  const notifications = await buildProvisioningNotifications(sub)
  return notifications.filter(n => n.type === 'provisioning_required')
}

// Returns [{ type: 'cancelled', to, sub, licenseName, reason }] for the
// caller to email — unless { silent: true }, which skips the re-select and
// returns null. Use silent for self-cancel (see handleCancel() in
// MySubscriptions.jsx): a user cancelling their own subscription doesn't
// need to be emailed about it.
export async function cancelSubscription(subscriptionId, reason, { silent = false } = {}) {
  const { error } = await supabase.rpc('cancel_subscription', { p_subscription_id: subscriptionId, p_reason: reason || null })
  if (error) throw error
  if (silent) return null

  const { data: sub, error: subError } = await supabase
    .from('subscriptions')
    .select(SUB_EMAIL_FIELDS)
    .eq('id', subscriptionId)
    .single()
  if (subError) throw subError

  return [{ type: 'cancelled', to: sub.user_email, sub, licenseName: sub.license.name, reason: reason || null }]
}

// Resolves who a renewal reminder for this subscription should reach: the
// owner (sub.user_email) always, plus whoever originally requested it — CC'd,
// not TO'd — when that's a different person (e.g. Kate requesting a license
// for Joe: Joe gets renewed, Kate is CC'd since she's the one who'll field
// the renew/cancel call). Reuses the same audit_log 'requested'-action lookup
// as resendApprovalRequest() above rather than subscriptions.requested_by
// (a profiles uuid FK) — a plain SELECT against profiles by id would 404
// under RLS for a non-admin service manager, since "profiles: own read" only
// allows reading your own row or every row as an admin.
export async function buildRenewalReminderNotification(sub) {
  const { data: auditRows } = await supabase
    .from('audit_log')
    .select('performed_by')
    .eq('subscription_id', sub.id)
    .eq('action', 'requested')
    .order('created_at', { ascending: false })
    .limit(1)
  const requesterEmail = auditRows?.[0]?.performed_by
  const cc = requesterEmail && requesterEmail.toLowerCase() !== sub.user_email.toLowerCase() ? [requesterEmail] : []
  return { to: sub.user_email, cc, licenseName: sub.license.name }
}

export async function optInRenewal(subscriptionId) {
  const { error } = await supabase.rpc('opt_in_renewal', { p_subscription_id: subscriptionId })
  if (error) throw error
}

export async function optOutRenewal(subscriptionId) {
  const { error } = await supabase.rpc('opt_out_renewal', { p_subscription_id: subscriptionId })
  if (error) throw error
}

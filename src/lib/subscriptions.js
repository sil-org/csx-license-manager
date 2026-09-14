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
    .select('*, license:licenses(name, vendor, category, logo_url, price)')
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

// Classifies a suggested-approver email as a Google Group or an individual
// via the classify-approver-email Edge Function (a Directory API groups.get
// lookup) — request_subscription() can't make that call itself, so it's done
// here, client-side, right before submitting. A group address typed into
// "suggested approver" needs this tag (pending_approver_is_group) so
// get_my_pending_sk_verifications()/confirm_sk_ownership() accept any
// current member of that group instead of only an exact profile-email
// match nobody in the group could ever satisfy — see 2026-09-01's
// operations_gslt@sil.org / alan_yam@sil.org incident. Falls back to
// treating it as an individual on any classification failure (network
// error, Directory API hiccup) — that's today's existing behavior, not a
// new failure mode, just missing the group fast-path.
async function classifyApproverEmail(email) {
  try {
    const { data, error } = await supabase.functions.invoke('classify-approver-email', { body: { email } })
    if (error) throw error
    return data?.type === 'group'
  } catch {
    return false
  }
}

// Returns { id, status, notify } — notify is null unless someone needs to be
// emailed as a result, otherwise an array of { type, to, ... } entries (see
// notifyForRequest() in src/pages/Catalog.jsx, which dispatches on type).
export async function requestSubscription({ licenseId, suiteKey, suggestedApproverEmail, ministryId, fy, recipientEmail, extraFieldValue, acknowledged }) {
  const suggestedApproverIsGroup = suggestedApproverEmail ? await classifyApproverEmail(suggestedApproverEmail) : false

  const { data: id, error } = await supabase.rpc('request_subscription', {
    p_license_id: licenseId,
    p_suite_key: suiteKey || null,
    p_suggested_approver_email: suggestedApproverEmail || null,
    p_suggested_approver_is_group: suggestedApproverIsGroup,
    p_ministry_id: ministryId || null,
    p_fy: fy,
    p_recipient_email: recipientEmail || null,
    p_extra_field_value: extraFieldValue || null,
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
    price: sub.license?.price, priceUnit: sub.license?.price_unit,
  }
}

// Re-sends the 'sk_verification' email to whoever's being asked to confirm
// ownership of the subscription's SuiteKey. Unlike resendApprovalRequest()'s
// resolved-owner lookup, the pending approver for this status is tracked
// directly on the subscription (subscriptions.pending_approver_email), so
// there's nothing to query — this is synchronous.
export function resendSkVerification(sub) {
  if (!sub.pending_approver_email) return null
  return { type: 'sk_verification', to: sub.pending_approver_email, suiteKey: sub.suite_key }
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

// Admin-only. Opens a renewal period for every eligible active annual
// subscription of one license/fiscal-year — see start_renewal_period() in
// supabase/schema_licenses.sql. Returns one row per subscription with
// everything needed to build the reminder email; caller groups by owner and
// sends (see Catalog.jsx's handleStartRenewalPeriod), same shape as
// send-renewal-reminders/index.ts's weekly nag.
export async function startRenewalPeriod(licenseId, fiscalYear) {
  const { data, error } = await supabase.rpc('start_renewal_period', {
    p_license_id: licenseId, p_fiscal_year: fiscalYear,
  })
  if (error) throw error
  return data
}

export async function optInRenewal(subscriptionId) {
  const { error } = await supabase.rpc('opt_in_renewal', { p_subscription_id: subscriptionId })
  if (error) throw error
}

export async function optOutRenewal(subscriptionId) {
  const { error } = await supabase.rpc('opt_out_renewal', { p_subscription_id: subscriptionId })
  if (error) throw error
}

// Admin-only repoint of an already-existing subscription onto a different
// SuiteKey (Admin -> All Subscriptions' details modal) — e.g. it was billed
// against the wrong key, or the underlying budget moved to a new one. Unlike
// requestSubscription(), never touches status/activated_at: this is "fix
// which key pays for it," not a fresh request, so the subscription keeps
// running exactly as it was. Still notifies the new key's owner (or, if
// unclaimed, the suggestedApproverEmail the caller supplies) that a request
// now sits against their key — see admin_update_subscription_suite_key() for
// why that's a heads-up rather than a gate on this subscription. Returns
// null if there's nobody to notify (shouldn't normally happen — the RPC
// itself requires either a resolved owner or a suggested approver).
export async function updateSubscriptionSuiteKey(subscriptionId, suiteKey, suggestedApproverEmail) {
  const suggestedApproverIsGroup = suggestedApproverEmail ? await classifyApproverEmail(suggestedApproverEmail) : false
  const { data, error } = await supabase.rpc('admin_update_subscription_suite_key', {
    p_subscription_id: subscriptionId,
    p_suite_key: suiteKey,
    p_suggested_approver_email: suggestedApproverEmail || null,
    p_suggested_approver_is_group: suggestedApproverIsGroup,
  })
  if (error) throw error
  const row = data?.[0]
  if (!row) return null
  if (row.pending_verification) {
    return { type: 'sk_verification', to: suggestedApproverEmail, suiteKey: row.suite_key }
  }
  const to = row.owner_group_email || row.owner_email
  return to ? { type: 'approval_request', to, suiteKey: row.suite_key } : null
}

// Notes/product key/invoice number/price paid — the "purchase details" set
// edited together from one modal in Admin -> All Subscriptions. notes is
// distinct from the license's own catalog-level notes field — see
// update_subscription_details() in supabase/schema_licenses.sql.
export async function updateSubscriptionDetails(subscriptionId, { notes, productKey, invoiceNumber, pricePaid, extraFieldValue }) {
  const { error } = await supabase.rpc('update_subscription_details', {
    p_subscription_id: subscriptionId,
    p_notes: notes || null,
    p_product_key: productKey || null,
    p_invoice_number: invoiceNumber || null,
    p_price_paid: pricePaid === '' || pricePaid == null ? null : Number(pricePaid),
    p_extra_field_value: extraFieldValue || null,
  })
  if (error) throw error
}

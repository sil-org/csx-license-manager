import { supabase } from './supabase'
import { billingLabel, fyLabel } from './subscriptionDisplay'

// Mirrors Emails.gs / the inline MailApp.sendEmail() calls in Subscriptions.gs
// and Approvals.gs. Unlike the GAS originals, none of these embed one-click
// action links — the new app's actions all happen on the authenticated
// /approvals page (RLS already scopes it to what each signed-in user can act
// on), so emails just point people there instead of carrying a bearer-token
// link per subscription.

// TEMPORARY, while Kate isn't yet comfortable trusting the app fully
// unsupervised: every outbound email BCCs her regardless of what the caller
// passed, on top of (not instead of) any real action-needed BCC a caller
// sets — e.g. buildProvisioningNotifications' admin fallback in
// subscriptions.js, which stays separate since that recipient actually has
// something to do. Remove OVERSIGHT_BCC (and the merge below) once she is.
const OVERSIGHT_BCC = 'kate_brenner@sil.org'

export async function sendEmail({ to, subject, html, template, subscriptionId, bcc }) {
  const allBcc = [...new Set([...(bcc || []), OVERSIGHT_BCC])]
  const { error } = await supabase.functions.invoke('send-email', {
    body: {
      to,
      subject,
      html,
      template,
      subscription_id: subscriptionId || null,
      bcc: allBcc,
    },
  })
  if (error) throw error
}

// Always the production host, regardless of where the email was actually
// sent from (e.g. a dev's localhost) — a recipient clicking a link in their
// inbox should never land on someone's local dev server.
const APP_ORIGIN = 'https://licensemanager.sil.org'

function appUrl(path) {
  return `${APP_ORIGIN}${path}`
}

// `heading` is topic-specific ("SuiteKey Ownership Confirmation", "Seat
// Provisioning Required", ...) rather than a generic "License Manager"
// brand line — every template names its own heading now, and "License
// Manager" only shows up as an inline link where the body text needs it.
function wrapEmail(heading, bodyHtml, footer = {
  text: 'You can also act on this from',
  path: '/approvals',
  linkText: 'License Manager → Approvals',
}) {
  return `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #202124;">
  <h2 style="color: #005CB9; margin: 0 0 16px; font-size: 20px;">${heading}</h2>
  ${bodyHtml}
  <p style="color: #666666; font-size: 12px; margin-top: 24px;">
    ${footer.text}
    <a href="${appUrl(footer.path)}" style="color: #005CB9;">${footer.linkText}</a>.
  </p>
</div>`
}

function detailsTable(rows) {
  const trs = rows.map(([label, value], i) => `
    <tr style="${i % 2 === 1 ? 'background:#f8f9fa' : ''}">
      <td style="padding:6px 12px;color:#666666;width:140px">${label}</td>
      <td style="padding:6px 12px">${value}</td>
    </tr>`).join('')
  return `<table style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0">${trs}</table>`
}

// Big pill-style call-to-action link(s), styled like buttons — every href
// still routes through the app's own sign-in (see the module comment up
// top), so these are a visual affordance, not a bearer-token shortcut.
// `color`: 'green' | 'red' | 'blue' (default).
function ctaButtons(buttons) {
  const colors = { green: '#1e8e3e', red: '#D52227', blue: '#005CB9' }
  const items = buttons.map(b => `
    <a href="${b.href}" style="background:${colors[b.color] || colors.blue};color:#ffffff;padding:12px 22px;
       border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;margin:4px 10px 4px 0;
       font-size:14px">${b.label}</a>`).join('')
  return `<div style="margin:20px 0">${items}</div>`
}

export function skVerificationEmailSubject(suiteKey) {
  return `Action Required: SuiteKey Ownership Confirmation — ${suiteKey}`
}

export function skVerificationEmailHtml({ suiteKey, licenseName, requesterEmail, recipientEmail }) {
  return wrapEmail('SuiteKey Ownership Confirmation', `
    <p>You've been identified as the potential owner of SuiteKey <strong>${suiteKey}</strong> in
       <a href="${appUrl('/')}" style="color:#005CB9">License Manager</a>. A license request has been
       submitted against this SuiteKey and requires your confirmation before it can proceed.</p>
    ${detailsTable([
      ['SuiteKey', `<strong>${suiteKey}</strong>`],
      ['License', licenseName],
      ['Requested by', `<a href="mailto:${requesterEmail}" style="color:#005CB9">${requesterEmail}</a>`],
      ...(recipientEmail && recipientEmail !== requesterEmail ? [['License is for', recipientEmail]] : []),
    ])}
    <p>Are you the budget manager for SuiteKey <strong>${suiteKey}</strong>?</p>
    ${ctaButtons([
      { label: '✓ Yes, I manage this SuiteKey', href: appUrl('/approvals'), color: 'green' },
      { label: '✗ No, I don’t manage it', href: appUrl('/approvals'), color: 'red' },
    ])}
    <p style="font-size:13px;color:#666666">
      Sign in to confirm either way — if you confirm ownership, you'll be registered as the SuiteKey
      owner and immediately asked to approve or decline this specific license request. If you're not
      the right person, choose "No" and the requester will be notified to resubmit with the correct approver.
    </p>
  `)
}

export function approvalRequestEmailSubject(suiteKey) {
  return `Action Required: License request for SuiteKey ${suiteKey}`
}

export function approvalRequestEmailHtml({ suiteKey, licenseName, userEmail, recipientEmail, moreInfoUrl }) {
  return wrapEmail('License Request Needs Your Approval', `
    <p>A software license has been requested against your SuiteKey and needs your approval.</p>
    ${detailsTable([
      ['SuiteKey', `<strong>${suiteKey}</strong>`],
      ['License', licenseName],
      ['Requested by', `<a href="mailto:${userEmail}" style="color:#005CB9">${userEmail}</a>`],
      ...(recipientEmail && recipientEmail !== userEmail ? [['License is for', recipientEmail]] : []),
      ...(moreInfoUrl ? [['More info', `<a href="${moreInfoUrl}" style="color:#005CB9">${moreInfoUrl}</a>`]] : []),
    ])}
    ${ctaButtons([
      { label: '✓ Approve', href: appUrl('/approvals'), color: 'green' },
      { label: '✗ Decline', href: appUrl('/approvals'), color: 'red' },
    ])}
    <p style="font-size:13px;color:#666666">Sign in to complete either action on the Approvals page.</p>
  `)
}

export function suiteKeyAssignedEmailSubject(suiteKey) {
  return `You've been assigned as the owner of SuiteKey ${suiteKey}`
}

export function suiteKeyAssignedEmailHtml({ suiteKey, pendingCount }) {
  return wrapEmail('You’re Now a SuiteKey Owner', `
    <p>An admin has registered you as the budget owner for SuiteKey <strong>${suiteKey}</strong> in
       <a href="${appUrl('/')}" style="color:#005CB9">License Manager</a>.</p>
    ${pendingCount > 0 ? `
    <p>${pendingCount} request${pendingCount === 1 ? ' is' : 's are'} already waiting on your approval.</p>
    ${ctaButtons([{ label: 'Review Requests', href: appUrl('/approvals'), color: 'blue' }])}
    ` : `
    <p style="font-size:13px;color:#666666">Sign in any time you have requests to review.</p>
    `}
  `)
}

export function activationEmailSubject(licenseName) {
  return `Your ${licenseName} account is ready!`
}

// Mirrors Emails.gs's _notifyUserOfActivation() — sent once a subscription
// reaches 'active'. Not built at all until now; the GAS original was never
// carried over during the initial port. `onboardingMessage` is the
// per-license override (licenses.onboarding_message, set in Admin → Catalog);
// falls back to a generic default if the license doesn't have one set. FY is
// only shown when it's a meaningful concept for this subscription — see
// src/lib/subscriptionDisplay.js.
export function activationEmailHtml({ sub, licenseName, onboardingMessage, moreInfoUrl }) {
  const intro = onboardingMessage
    ? onboardingMessage
    : `Your <strong>${licenseName}</strong> account has been set up and is ready to use.`
  const fy = fyLabel(sub)
  return wrapEmail('Your License Is Ready', `
    <p>${intro}</p>
    ${detailsTable([
      ['License', licenseName],
      ['Billing', billingLabel(sub)],
      ...(fy ? [['Fiscal Year', fy]] : []),
      ...(moreInfoUrl ? [['More info', `<a href="${moreInfoUrl}" style="color:#005CB9">${moreInfoUrl}</a>`]] : []),
    ])}
    ${ctaButtons([{ label: 'View My Subscriptions', href: appUrl('/subscriptions'), color: 'blue' }])}
    <p style="font-size:13px;color:#666666">Questions? Contact the License Manager team.</p>
  `, { text: 'View your subscriptions at', path: '/subscriptions', linkText: 'License Manager → My Subscriptions' })
}

export function renewalReminderEmailSubject() {
  return 'Action Required: Software License Renewal'
}

// One license's card within the weekly renewal-reminder digest — mirrors
// Emails.gs's sendPerLicenseReminders(), which batches one card per
// upcoming-renewal license into a single weekly email per user. The digest
// sender itself isn't built yet (see README's "not ported yet" list) — this
// is the content half, so Admin → Catalog has somewhere to author and
// preview the per-license override ahead of that. `reminderMessage` is the
// per-license override (licenses.reminder_message); falls back to a generic
// default when unset, same pattern as activationEmailHtml's onboardingMessage.
export function renewalReminderCardHtml({ licenseName, suiteKey, priceLabel, renewalLabel, reminderMessage }) {
  const intro = reminderMessage || `Your <strong>${licenseName}</strong> subscription is coming up for renewal.`
  return `
    <div style="border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin:12px 0">
      <div style="font-weight:600;font-size:15px;color:#202124">${licenseName}</div>
      <p style="margin:8px 0;font-size:14px">${intro}</p>
      <div style="color:#666666;font-size:13px;margin:4px 0 12px">
        SuiteKey: ${suiteKey}${renewalLabel ? ` • Renews ${renewalLabel}` : ''}${priceLabel ? ` • ${priceLabel}` : ''}
      </div>
      ${ctaButtons([
        { label: '✓ Yes, Renew', href: appUrl('/subscriptions'), color: 'green' },
        { label: '✗ No, Don’t Renew', href: appUrl('/subscriptions'), color: 'red' },
      ])}
    </div>`
}

// Wraps one or more renewalReminderCardHtml() cards into the full digest
// email. Exported mainly for the Admin -> Catalog preview (a single card);
// the eventual digest sender would call this with every card for a user
// concatenated together.
export function renewalReminderEmailHtml({ cardsHtml }) {
  return wrapEmail('Software License Renewal Reminder', `
    <p>The following annual licenses are coming up for renewal. Please indicate whether you'd like to continue each subscription:</p>
    ${cardsHtml}
    <p style="font-size:13px;color:#666666">
      You'll receive weekly reminders until you respond for each license. Once you reply, no further
      reminders will be sent for that subscription. Questions? Contact the License Manager team.
    </p>
  `, { text: 'Respond any time from', path: '/subscriptions', linkText: 'License Manager → My Subscriptions' })
}

export function approvedPendingEmailSubject(licenseName) {
  return `License Request Approved — Setup in Progress: ${licenseName}`
}

// Mirrors Approvals.gs's _notifySubscriberApprovedPending() — sent to the
// requester when their request lands in 'approved' (needs provisioning)
// rather than going straight to 'active', so they're not left wondering why
// they don't have access yet.
export function approvedPendingEmailHtml({ sub, licenseName }) {
  const fy = fyLabel(sub)
  return wrapEmail('Request Approved — Setup in Progress', `
    <p>Your request for <strong>${licenseName}</strong> has been approved.</p>
    <p>The License Manager team is now setting up your account. You'll receive another email
       once your access is ready — this may take a few business days.</p>
    ${detailsTable([
      ['License', licenseName],
      ['Billing', billingLabel(sub)],
      ...(fy ? [['Fiscal Year', fy]] : []),
    ])}
    <p style="font-size:13px;color:#666666">Questions? Contact the License Manager team.</p>
  `, { text: 'View your subscriptions at', path: '/subscriptions', linkText: 'License Manager → My Subscriptions' })
}

export function provisioningRequiredEmailSubject({ licenseName, userEmail }) {
  return `Action Required: Provision seat — ${licenseName} for ${userEmail}`
}

// Mirrors Approvals.gs's _notifyAdminsOfPendingActivation() — sent to the
// license's service manager (or admins, if none is set) whenever a
// subscription needs a seat provisioned on the vendor side before it can be
// marked active. `apiResult` is a hook for a future automated provisioning
// integration (none exists yet — every license's activation_url is a manual
// vendor-portal link) — omit it for today's manual-provisioning case.
export function provisioningRequiredEmailHtml({ sub, licenseName, activationUrl, apiResult }) {
  const fy = fyLabel(sub)
  const status = apiResult === 'success'
    ? `<p>This seat was <strong>provisioned automatically via API</strong> — no manual action needed.</p>`
    : apiResult === 'failed'
      ? `<div style="background:#fce8e6;border-left:4px solid #D52227;border-radius:4px;padding:10px 14px;margin:16px 0;font-size:14px">
           Automatic API provisioning failed for this seat — please provision it manually.
         </div>`
      : `<p>A subscription has been approved and is waiting for you to provision the seat on the vendor side.</p>`
  return wrapEmail('Seat Provisioning Required', `
    ${status}
    ${detailsTable([
      ['User', sub.user_email],
      ['License', licenseName],
      ['Billing', billingLabel(sub)],
      ...(fy ? [['Fiscal Year', fy]] : []),
    ])}
    ${ctaButtons([
      ...(activationUrl ? [{ label: 'Open Vendor Portal →', href: activationUrl, color: 'blue' }] : []),
      { label: 'Mark Active', href: appUrl('/admin/all-subscriptions'), color: 'green' },
    ])}
    <p style="color:#666666;font-size:13px">Once the seat is provisioned, mark it as activated from Subscriptions — the user will be notified automatically.</p>
  `)
}

export function skOwnershipDeniedEmailSubject(licenseName) {
  return `License Request Declined: ${licenseName}`
}

export function skOwnershipDeniedEmailHtml({ suiteKey, licenseName }) {
  return wrapEmail('License Request Declined', `
    <p>Your request for <strong>${licenseName}</strong> has been declined.</p>
    <div style="background:#fce8e6;border-left:4px solid #D52227;border-radius:4px;padding:10px 14px;margin:16px 0;font-size:14px">
      The person we asked to confirm ownership of SuiteKey <strong>${suiteKey}</strong> indicated they don't manage it.
    </div>
    <p style="font-size:13px;color:#666666">Please resubmit your request with the correct SuiteKey or approver.</p>
  `)
}

export function decisionApprovedEmailSubject(licenseName) {
  return `License Request Approved: ${licenseName}`
}

// Mirrors Approvals.gs's _notifySubscriberOfDecision() for the 'approved'
// case — sent when a SuiteKey owner approves a request that goes straight to
// 'active' (no provisioning needed). The needs-provisioning case has its own
// email — see approvedPendingEmailHtml above.
export function decisionApprovedEmailHtml({ sub, licenseName }) {
  const fy = fyLabel(sub)
  return wrapEmail('License Request Approved', `
    <p>Your request for <strong>${licenseName}</strong> has been approved. Your subscription is now active.</p>
    ${detailsTable([
      ['License', licenseName],
      ['Billing', billingLabel(sub)],
      ...(fy ? [['Fiscal Year', fy]] : []),
    ])}
    <p style="font-size:13px;color:#666666">Questions? Contact the License Manager team.</p>
  `, { text: 'View your subscriptions at', path: '/subscriptions', linkText: 'License Manager → My Subscriptions' })
}

export function declinedEmailSubject(licenseName) {
  return `License Request Declined: ${licenseName}`
}

// Mirrors Approvals.gs's _notifySubscriberOfDecision() for the 'declined'
// case — sent when a SuiteKey owner declines a pending request. `reason` is
// the optional free-text notes decline_subscription() was called with.
export function declinedEmailHtml({ sub, licenseName, performedBy, reason }) {
  const fy = fyLabel(sub)
  return wrapEmail('License Request Declined', `
    <p>Your request for <strong>${licenseName}</strong> has been declined.</p>
    ${reason ? `
    <div style="background:#fce8e6;border-left:4px solid #D52227;border-radius:4px;padding:10px 14px;margin:16px 0;font-size:14px">
      <strong style="color:#D52227">Reason given:</strong><br>${reason}
    </div>` : ''}
    ${detailsTable([
      ['License', licenseName],
      ['Billing', billingLabel(sub)],
      ...(fy ? [['Fiscal Year', fy]] : []),
    ])}
    <p style="font-size:13px;color:#666666">
      Declined by SuiteKey owner: <a href="mailto:${performedBy}" style="color:#005CB9">${performedBy}</a>.
      If you have questions, you can reply directly to them.
    </p>
  `)
}

export function revokedEmailSubject(licenseName) {
  return `License Subscription Revoked: ${licenseName}`
}

// Mirrors Approvals.gs's _notifySubscriberOfDecision() for the 'revoked'
// case — sent when a SuiteKey owner or admin revokes a previously-active
// subscription.
export function revokedEmailHtml({ sub, licenseName, performedBy, reason }) {
  const fy = fyLabel(sub)
  return wrapEmail('License Subscription Revoked', `
    <p>Your subscription to <strong>${licenseName}</strong> has been revoked by <a href="mailto:${performedBy}" style="color:#005CB9">${performedBy}</a>.</p>
    ${reason ? `
    <div style="background:#fce8e6;border-left:4px solid #D52227;border-radius:4px;padding:10px 14px;margin:16px 0;font-size:14px">
      <strong style="color:#D52227">Reason given:</strong><br>${reason}
    </div>` : ''}
    ${detailsTable([
      ['License', licenseName],
      ['Billing', billingLabel(sub)],
      ...(fy ? [['Fiscal Year', fy]] : []),
    ])}
    <p style="font-size:13px;color:#666666">Questions? Contact <a href="mailto:${performedBy}" style="color:#005CB9">${performedBy}</a>.</p>
  `)
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}


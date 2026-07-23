import { supabase } from './supabase'
import { billingLabel, fyLabel } from './subscriptionDisplay'

// Mirrors Emails.gs / the inline MailApp.sendEmail() calls in Subscriptions.gs
// and Approvals.gs. Unlike the GAS originals, none of these embed one-click
// action links — the new app's actions all happen on the authenticated
// /approvals page (RLS already scopes it to what each signed-in user can act
// on), so emails just point people there instead of carrying a bearer-token
// link per subscription.

export async function sendEmail({ to, subject, html, template, subscriptionId }) {
  const { error } = await supabase.functions.invoke('send-email', {
    body: {
      to,
      subject,
      html,
      template,
      subscription_id: subscriptionId || null,
    },
  })
  if (error) throw error
}

function appUrl(path) {
  return `${window.location.origin}${path}`
}

function wrapEmail(bodyHtml, footer = {
  text: 'You can also act on this from',
  path: '/approvals',
  linkText: 'License Manager → Approvals',
}) {
  return `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #202124;">
  <h3 style="color: #005CB9; margin: 0 0 12px;">License Manager</h3>
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

export function skVerificationEmailSubject(suiteKey) {
  return `Action Required: SuiteKey Ownership Confirmation — ${suiteKey}`
}

export function skVerificationEmailHtml({ suiteKey, licenseName, requesterEmail }) {
  return wrapEmail(`
    <p>You've been identified as the potential owner of SuiteKey <strong>${suiteKey}</strong>.
       A license request has been submitted against it and needs your confirmation before it can proceed.</p>
    ${detailsTable([
      ['SuiteKey', `<strong>${suiteKey}</strong>`],
      ['License', licenseName],
      ['Requested by', requesterEmail],
    ])}
    <p>Sign in to <a href="${appUrl('/approvals')}" style="color:#005CB9">License Manager &rarr; Approvals</a>
       to confirm or deny that you manage this SuiteKey.</p>
  `)
}

export function approvalRequestEmailSubject(suiteKey) {
  return `Action Required: License request for SuiteKey ${suiteKey}`
}

export function approvalRequestEmailHtml({ suiteKey, licenseName, userEmail }) {
  return wrapEmail(`
    <p>A software license has been requested against your SuiteKey and needs your approval.</p>
    ${detailsTable([
      ['SuiteKey', `<strong>${suiteKey}</strong>`],
      ['License', licenseName],
      ['Requested by', userEmail],
    ])}
    <p>Sign in to <a href="${appUrl('/approvals')}" style="color:#005CB9">License Manager &rarr; Approvals</a>
       to approve or decline this request.</p>
  `)
}

export function suiteKeyAssignedEmailSubject(suiteKey) {
  return `You've been assigned as the owner of SuiteKey ${suiteKey}`
}

export function suiteKeyAssignedEmailHtml({ suiteKey, pendingCount }) {
  return wrapEmail(`
    <p>An admin has registered you as the budget owner for SuiteKey <strong>${suiteKey}</strong> in License Manager.</p>
    ${pendingCount > 0 ? `
    <p>${pendingCount} request${pendingCount === 1 ? ' is' : 's are'} already waiting on your approval.</p>
    ` : ''}
    <p>Sign in to <a href="${appUrl('/approvals')}" style="color:#005CB9">License Manager &rarr; Approvals</a>
       any time you have requests to review.</p>
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
export function activationEmailHtml({ sub, licenseName, onboardingMessage }) {
  const intro = onboardingMessage
    ? onboardingMessage
    : `Your <strong>${licenseName}</strong> account has been set up and is ready to use.`
  const fy = fyLabel(sub)
  return wrapEmail(`
    <p>${intro}</p>
    ${detailsTable([
      ['License', licenseName],
      ['Billing', billingLabel(sub)],
      ...(fy ? [['Fiscal Year', fy]] : []),
    ])}
    <p style="font-size:13px;color:#666666">Questions? Contact the License Manager team.</p>
  `, { text: 'View your subscriptions at', path: '/subscriptions', linkText: 'License Manager → My Subscriptions' })
}

export function skOwnershipDeniedEmailSubject(licenseName) {
  return `License Request Declined: ${licenseName}`
}

export function skOwnershipDeniedEmailHtml({ suiteKey, licenseName }) {
  return wrapEmail(`
    <p>Your request for <strong>${licenseName}</strong> has been declined.</p>
    <div style="background:#fce8e6;border-left:4px solid #D52227;border-radius:4px;padding:10px 14px;margin:16px 0;font-size:14px">
      The person we asked to confirm ownership of SuiteKey <strong>${suiteKey}</strong> indicated they don't manage it.
    </div>
    <p style="font-size:13px;color:#666666">Please resubmit your request with the correct SuiteKey or approver.</p>
  `)
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export function feedbackEmailSubject() {
  return 'License Manager feedback'
}

const RATING_LABELS = { 1: 'Very unhappy', 2: 'Unhappy', 3: 'Neutral', 4: 'Happy', 5: 'Very happy' }

// Free-text user input, unlike every other field this module emails —
// escaped so a pasted `<` or stray quote can't break the layout (or worse)
// in the recipient's inbox.
export function feedbackEmailHtml({ rating, message, userEmail, page }) {
  return wrapEmail(`
    ${message ? `<p style="white-space:pre-wrap">${escapeHtml(message)}</p>` : ''}
    ${detailsTable([
      ['Rating', rating ? `${rating}/5 (${RATING_LABELS[rating]})` : 'not given'],
      ['From', escapeHtml(userEmail || 'unknown')],
      ['Page', escapeHtml(page)],
    ])}
  `, { text: 'Sign in to', path: '/', linkText: 'License Manager' })
}

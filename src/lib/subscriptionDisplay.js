// Shared display helpers for subscription rows — used across My Subscriptions,
// My Team, SuiteKey Charges, and outbound emails, so this logic lives in
// exactly one place instead of being copy-pasted per page.

export const STATUS_LABEL = {
  pending_sk_verification: 'Awaiting SuiteKey verification',
  pending: 'Awaiting approval',
  approved: 'Approved — being provisioned',
  active: 'Active',
  declined: 'Declined',
  revoked: 'Revoked',
  cancelled: 'Cancelled',
}

export const STATUS_COLOR = {
  pending_sk_verification: 'text-sil-yellow',
  pending: 'text-sil-yellow',
  approved: 'text-sil-light-blue',
  active: 'text-sil-green',
  declined: 'text-sil-red',
  revoked: 'text-sil-red',
  cancelled: 'text-gray-400',
}

// Same palette as STATUS_COLOR, as a pill background+text combo for cards
// (e.g. My Subscriptions) instead of plain colored text.
export const STATUS_BADGE = {
  pending_sk_verification: 'bg-sil-yellow/10 text-sil-yellow',
  pending: 'bg-sil-yellow/10 text-sil-yellow',
  approved: 'bg-sil-light-blue/10 text-sil-light-blue',
  active: 'bg-sil-green/10 text-sil-green',
  declined: 'bg-sil-red/10 text-sil-red',
  revoked: 'bg-sil-red/10 text-sil-red',
  cancelled: 'bg-gray-100 text-gray-400',
}

// Terminal, no-longer-relevant statuses — hidden by default on My
// Subscriptions and My Team so old cancelled/declined/revoked requests don't
// clutter the list of what's actually current.
export const INACTIVE_STATUSES = ['cancelled', 'declined', 'revoked']

export const RENEWAL_LABEL = {
  none: 'Awaiting decision',
  opted_in: 'Renewing',
  opted_out: 'Not renewing',
}

export const RENEWAL_COLOR = {
  none: 'text-sil-yellow',
  opted_in: 'text-sil-green',
  opted_out: 'text-sil-red',
}

// renewal_status only reflects a real decision for annual, non-GTIS
// subscriptions — mirrors isRenewalReminderEligible() in AllSubscriptions.jsx.
// Monthly and GTIS-sponsored subscriptions carry the 'none' default but never
// present a renew/cancel choice, so showing it there would be misleading.
export function shouldShowRenewal(sub) {
  return sub.billing_cycle === 'annual' && sub.billing_type !== 'gtis'
}

export function billingLabel(sub) {
  if (sub.billing_type === 'gtis') return 'GTIS'
  if (sub.billing_type === 'ministry') return `Ministry ID ${sub.ministry_id}`
  if (sub.billing_type === 'department') return 'Free (department-approved)'
  return sub.suite_key
}

// Fiscal year isn't a meaningful concept for month-to-month billing or
// GTIS-sponsored licenses, which don't follow the FY renewal cycle — hide it
// rather than show a number that doesn't mean anything for these.
export function shouldShowFY(sub) {
  return sub.billing_cycle !== 'monthly' && sub.billing_type !== 'gtis'
}

export function fyLabel(sub) {
  return shouldShowFY(sub) ? `FY${sub.fy}` : null
}

// Next occurrence of the 1st of renewalMonth — this year if it hasn't
// happened yet, otherwise next year. Mirrors Emails.gs's renewal-date
// calculation (gas-legacy/src/Emails.gs), used for the renewal-reminder
// email's "Renews <date>" line.
export function nextRenewalLabel(renewalMonth) {
  if (!renewalMonth) return null
  const now = new Date()
  let date = new Date(now.getFullYear(), renewalMonth - 1, 1)
  if (date.getTime() <= now.getTime()) date = new Date(now.getFullYear() + 1, renewalMonth - 1, 1)
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

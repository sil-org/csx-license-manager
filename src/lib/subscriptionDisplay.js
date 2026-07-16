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

export function billingLabel(sub) {
  if (sub.billing_type === 'gtis') return 'GTIS'
  if (sub.billing_type === 'ministry') return `Ministry ID ${sub.ministry_id}`
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

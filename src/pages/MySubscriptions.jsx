import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AppLayout from '../components/AppLayout'
import { getLinks } from '../navLinks'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { getMySubscriptions, cancelSubscription, optInRenewal, optOutRenewal } from '../lib/subscriptions'
import { fiscalYearOf } from '../lib/fiscalYear'
import { fyLabel, STATUS_LABEL, STATUS_BADGE, INACTIVE_STATUSES, PRICE_UNIT_LABEL, suiteKeyKeepsBillingAfterCancel } from '../lib/subscriptionDisplay'

// "SuiteKey: X" / "Ministry ID: X" / "GTIS-funded" / "No charge" — same underlying data as
// subscriptionDisplay.js's billingLabel(), phrased as prose for this page's
// card subtitle rather than a bare table-cell value.
function billingDescription(sub) {
  if (sub.billing_type === 'gtis') return 'GTIS-funded'
  if (sub.billing_type === 'ministry') return `Ministry ID: ${sub.ministry_id}`
  if (sub.billing_type === 'free') return 'No charge'
  return `SuiteKey: ${sub.suite_key}`
}

// Postgres numeric columns come through supabase-js as strings, hence the
// Number() — matches formatPrice() in Catalog.jsx.
function formatPrice(price) {
  const n = Number(price)
  return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`
}


// price_at_signup is frozen at whatever it was the day the subscription was
// first created — opt_in_renewal() bumps sub.fy to the new fiscal year but
// never updates price_at_signup itself. The real price for a later FY lives
// on the matching renewals row instead (opt_in_renewal() snapshots the
// license's price there at decision time), so once a subscription has
// renewed at least once, price_at_signup is stale.
//
// Only request_subscription() and opt_in_renewal() ever set sub.fy, and the
// latter always writes a matching renewals row in the same breath — so
// sub.fy outrunning both a renewals row AND its own signup year only
// happens for legacy-imported subscriptions, whose fy was carried straight
// over from the old GAS sheet across years with no renewals trail at all.
// For those (and for anything else that's simply outlived its first term
// with no tracked renewal), the license's current price is a far better
// answer than a possibly years-stale price_at_signup — a SuiteKey/Ministry
// annual subscription is always billed at the current catalog price on
// renewal anyway (same principle as the open_renewal_fy branch below).
function currentPeriodPrice(sub) {
  const decided = sub.renewals?.find(r => r.fiscal_year === sub.fy && r.decision === 'opted_in' && r.renewal_price != null)
  if (decided) return decided.renewal_price
  if (sub.price_at_signup != null && sub.fy === fiscalYearOf(sub.start_date)) return sub.price_at_signup
  return sub.license?.price ?? null
}

export default function MySubscriptions() {
  const { profile } = useAuth()
  const [subs, setSubs] = useState(null)
  const [error, setError] = useState(null)
  const [showInactive, setShowInactive] = useState(false)

  function reload() {
    getMySubscriptions(profile.primary_email).then(setSubs).catch(e => setError(e.message))
  }

  useEffect(() => {
    if (profile) reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile])

  async function handle(action, subscriptionId) {
    try {
      await action(subscriptionId)
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

  // Declining a renewal cancels the subscription right away (opt_out_renewal()),
  // so confirm first — same as the Cancel button below.
  async function handleOptOut(sub) {
    if (!window.confirm(`Cancel ${sub.license?.name || 'this license'}? It will end now, and you'll need to request it again if you change your mind.`)) return
    await handle(optOutRenewal, sub.id)
  }

  async function handleCancel(sub) {
    const billingWarning = suiteKeyKeepsBillingAfterCancel(sub)
      ? ` This license will continue to be charged to the committed SuiteKey or Ministry ID until a new requestor purchases this license.`
      : ''
    if (!confirm(`Cancel your subscription to ${sub.license?.name}? This can't be undone — you'd need to request it again from the Catalog.${billingWarning}`)) return
    try {
      await cancelSubscription(sub.id, null, { silent: true })
      reload()
      // Nudges sync-provisioning to reconcile now instead of waiting for its
      // next scheduled run — best effort, the schedule is the correctness
      // backstop if this fails.
      supabase.functions.invoke('sync-provisioning').catch(err => console.error('provisioning sync kick failed:', err.message))
      // Removes the current user from the license's Google Group, if it has
      // one — a single targeted removal, never a full-membership resync.
      supabase.functions.invoke('sync-provisioning', {
        body: { groupMembershipUpdate: { licenseId: sub.license_id, email: sub.user_email, action: 'remove' } },
      }).catch(err => console.error('group membership removal failed:', err.message))
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-display text-2xl font-bold text-gray-900">My Subscriptions</h1>
          <Link to="/catalog" className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2 hover:bg-brand-dark transition">
            + Add Subscription
          </Link>
        </div>

        {error && <p className="text-sil-red mb-4">{error}</p>}
        {!subs && !error && <p className="text-gray-400">Loading…</p>}
        {subs?.length === 0 && <p className="text-gray-400">You have no subscriptions yet — browse the Catalog to request one.</p>}
        {subs?.length > 0 && !showInactive && subs.every(s => INACTIVE_STATUSES.includes(s.status)) && (
          <p className="text-gray-400 mb-4">All of your subscriptions are cancelled/declined/revoked — check "Show cancelled/declined/revoked" below to see them.</p>
        )}

        {subs?.some(s => INACTIVE_STATUSES.includes(s.status)) && (
          <label className="flex items-center gap-2 text-sm text-gray-500 mb-4">
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Show cancelled/declined/revoked
          </label>
        )}

        <div className="space-y-3">
          {subs?.filter(sub => showInactive || !INACTIVE_STATUSES.includes(sub.status)).map(sub => (
            <div key={sub.id} className="bg-white rounded-xl shadow-xs p-5 flex items-center justify-between">
              <div>
                <p className="font-semibold text-gray-900">{sub.license?.name}</p>
                <p className="text-sm text-gray-500">
                  {billingDescription(sub)}{fyLabel(sub) && ` • ${fyLabel(sub)}`} • {sub.activated_at ? `Started ${sub.activated_at}` : `Requested ${sub.start_date}`}
                  {/* While a renewal decision is open, show the license's current full price (what
                      renewing actually costs — matches renewalPriceLabel() in lib/email.js, which is
                      what the renewal-reminder email already quoted). Otherwise currentPeriodPrice()
                      picks the decided renewal_price for sub.fy if one's on file, else falls back to
                      price_at_signup for a subscription still in its original signup term.
                      PRICE_UNIT_LABEL[sub.billing_cycle], not sub.license?.price_unit — the license's
                      current price/unit can drift after signup, but billing_cycle is a snapshot of
                      what this subscription was actually charged under. */}
                  {sub.open_renewal_fy != null && sub.license?.price != null
                    ? ` • ${formatPrice(sub.license.price)}/yr`
                    : currentPeriodPrice(sub) != null && ` • ${formatPrice(currentPeriodPrice(sub))}${PRICE_UNIT_LABEL[sub.billing_cycle] ? ` ${PRICE_UNIT_LABEL[sub.billing_cycle]}` : ''}`}
                </p>
                {sub.extra_field_value && (
                  <p className="text-sm text-gray-500">
                    {sub.license?.extra_field_label || 'Extra field'}: {sub.extra_field_value}
                  </p>
                )}
                {sub.status === 'active' && sub.open_renewal_fy != null && sub.billing_cycle === 'annual' && sub.renewals?.some(r => r.fiscal_year === sub.open_renewal_fy && r.awaiting_owner_approval) && (
                  <p className="text-xs text-amber-700 mt-2">
                    Renewal requested — waiting for the owner of SuiteKey {sub.suite_key} to approve it (the SuiteKey changed since this was last approved).
                    <button onClick={() => handle(optOutRenewal, sub.id)} className="ml-2 underline">Withdraw</button>
                  </p>
                )}
                {sub.status === 'active' && sub.open_renewal_fy != null && sub.billing_cycle === 'annual' && !sub.renewals?.some(r => r.fiscal_year === sub.open_renewal_fy && r.awaiting_owner_approval) && (
                  <div className="flex gap-2 mt-2">
                    <button onClick={() => handle(optInRenewal, sub.id)} className="text-xs font-medium text-white bg-sil-green rounded-lg px-2.5 py-1 hover:opacity-90 transition">Yes, renew</button>
                    <button onClick={() => handleOptOut(sub)} className="text-xs font-medium text-white bg-gray-400 rounded-lg px-2.5 py-1 hover:opacity-90 transition">No, cancel it</button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_BADGE[sub.status]}`}>
                  {STATUS_LABEL[sub.status]}
                </span>
                {['pending', 'pending_sk_verification', 'approved', 'active'].includes(sub.status) && (
                  <button
                    onClick={() => handleCancel(sub)}
                    className="text-sm font-medium text-sil-red border border-sil-red rounded-lg px-2.5 py-1 hover:bg-sil-red/5 transition whitespace-nowrap"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppLayout>
  )
}

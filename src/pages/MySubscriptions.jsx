import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AppLayout from '../components/AppLayout'
import { getLinks } from '../navLinks'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { getMySubscriptions, cancelSubscription, optInRenewal, optOutRenewal } from '../lib/subscriptions'
import { fyLabel, STATUS_LABEL, STATUS_BADGE, INACTIVE_STATUSES } from '../lib/subscriptionDisplay'

// "SuiteKey: X" / "Ministry ID: X" / "GTIS-funded" — same underlying data as
// subscriptionDisplay.js's billingLabel(), phrased as prose for this page's
// card subtitle rather than a bare table-cell value.
function billingDescription(sub) {
  if (sub.billing_type === 'gtis') return 'GTIS-funded'
  if (sub.billing_type === 'ministry') return `Ministry ID: ${sub.ministry_id}`
  return `SuiteKey: ${sub.suite_key}`
}

// Postgres numeric columns come through supabase-js as strings, hence the
// Number() — matches formatPrice() in Catalog.jsx.
function formatPrice(price) {
  const n = Number(price)
  return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`
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

  async function handleCancel(sub) {
    if (!confirm(`Cancel your subscription to ${sub.license?.name}? This can't be undone — you'd need to request it again from the Catalog.`)) return
    try {
      await cancelSubscription(sub.id, null, { silent: true })
      reload()
      // Nudges sync-provisioning to reconcile now instead of waiting for its
      // next scheduled run — best effort, the schedule is the correctness
      // backstop if this fails.
      supabase.functions.invoke('sync-provisioning').catch(err => console.error('provisioning sync kick failed:', err.message))
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
            <div key={sub.id} className="bg-white rounded-xl shadow-sm p-5 flex items-center justify-between">
              <div>
                <p className="font-semibold text-gray-900">{sub.license?.name}</p>
                <p className="text-sm text-gray-500">
                  {billingDescription(sub)}{fyLabel(sub) && ` • ${fyLabel(sub)}`} • {sub.activated_at ? `Started ${sub.activated_at}` : `Requested ${sub.start_date}`}
                  {sub.price_at_signup != null && ` • ${formatPrice(sub.price_at_signup)}${sub.license?.price_unit ? ` ${sub.license.price_unit}` : ''}`}
                </p>
                {sub.status === 'active' && sub.renewal_status === 'none' && sub.billing_cycle === 'annual' && (
                  <div className="flex gap-3 mt-1.5">
                    <button onClick={() => handle(optInRenewal, sub.id)} className="text-xs font-medium text-sil-green">Opt in to renew</button>
                    <button onClick={() => handle(optOutRenewal, sub.id)} className="text-xs font-medium text-gray-400">Opt out</button>
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

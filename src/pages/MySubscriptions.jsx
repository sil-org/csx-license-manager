import { useEffect, useState } from 'react'
import AppLayout from '../components/AppLayout'
import { getLinks } from '../navLinks'
import { useAuth } from '../context/AuthContext'
import { getMySubscriptions, cancelSubscription, optInRenewal, optOutRenewal } from '../lib/subscriptions'
import { billingLabel, fyLabel, STATUS_LABEL, STATUS_COLOR } from '../lib/subscriptionDisplay'

export default function MySubscriptions() {
  const { profile } = useAuth()
  const [subs, setSubs] = useState(null)
  const [error, setError] = useState(null)

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

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-3xl mx-auto p-6">
        <h1 className="font-display text-2xl font-bold text-brand mb-6">My Subscriptions</h1>

        {error && <p className="text-sil-red mb-4">{error}</p>}
        {!subs && !error && <p className="text-gray-400">Loading…</p>}
        {subs?.length === 0 && <p className="text-gray-400">You have no subscriptions yet — browse the Catalog to request one.</p>}

        <div className="space-y-3">
          {subs?.map(sub => (
            <div key={sub.id} className="bg-white rounded-xl shadow-sm p-5 flex items-center justify-between">
              <div>
                <p className="font-semibold text-brand">{sub.license?.name}</p>
                <p className={`text-sm ${STATUS_COLOR[sub.status]}`}>{STATUS_LABEL[sub.status]}</p>
                <p className="text-xs text-gray-400">{fyLabel(sub) && `${fyLabel(sub)} · `}{billingLabel(sub)}</p>
              </div>
              <div className="flex gap-2">
                {sub.status === 'active' && sub.renewal_status === 'none' && sub.billing_cycle !== 'one_time' && (
                  <>
                    <button onClick={() => handle(optInRenewal, sub.id)} className="text-xs font-medium text-sil-green">Opt in to renew</button>
                    <button onClick={() => handle(optOutRenewal, sub.id)} className="text-xs font-medium text-gray-400">Opt out</button>
                  </>
                )}
                {['pending', 'pending_sk_verification', 'approved', 'active'].includes(sub.status) && (
                  <button onClick={() => handle(cancelSubscription, sub.id)} className="text-xs font-medium text-sil-red">Cancel</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppLayout>
  )
}

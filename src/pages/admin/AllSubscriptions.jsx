import { useEffect, useState } from 'react'
import AppLayout from '../../components/AppLayout'
import AdminTabs from '../../components/AdminTabs'
import { getLinks } from '../../navLinks'
import { getAllSubscriptions } from '../../lib/admin'
import { activateSubscription } from '../../lib/approvals'
import { supabase } from '../../lib/supabase'
import { sendEmail, activationEmailSubject, activationEmailHtml } from '../../lib/email'
import { billingLabel, fyLabel, STATUS_LABEL, STATUS_COLOR } from '../../lib/subscriptionDisplay'

// Mirrors GAS's Admin Panel "All Subscriptions" tab — every subscription,
// every user, every status, unfiltered. Admin: SuiteKey Charges/My Team are
// scoped to what you own/manage; this is the one place to see everything.
export default function AdminAllSubscriptions() {
  const [subs, setSubs] = useState(null)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')

  function reload() {
    getAllSubscriptions().then(setSubs).catch(e => setError(e.message))
  }

  useEffect(reload, [])

  // Mirrors handleActivate() in Approvals.jsx — duplicated rather than shared
  // since that page's version is tied to its own provisioning-queue reload.
  async function handleActivate(sub) {
    try {
      await activateSubscription(sub.id)
      reload()
      try {
        await sendEmail({
          to: sub.user_email,
          subject: activationEmailSubject(sub.license?.name),
          html: activationEmailHtml({ sub, licenseName: sub.license?.name, onboardingMessage: sub.license?.onboarding_message }),
          template: 'activation',
          subscriptionId: sub.id,
        })
      } catch (err) {
        console.error('activation email failed:', err.message)
      }
      supabase.functions.invoke('sync-provisioning').catch(err => console.error('provisioning sync kick failed:', err.message))
    } catch (err) {
      setError(err.message)
    }
  }

  const q = search.trim().toLowerCase()
  const visibleSubs = !q ? subs : subs?.filter(s =>
    s.user_email.toLowerCase().includes(q) ||
    (s.license?.name || '').toLowerCase().includes(q) ||
    (s.suite_key || '').toLowerCase().includes(q) ||
    (s.ministry_id || '').toLowerCase().includes(q) ||
    s.status.toLowerCase().includes(q)
  )

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-6xl mx-auto p-6">
        <AdminTabs />
        <h1 className="font-display text-2xl font-bold text-brand mb-6">Admin — All Subscriptions</h1>
        {error && <p className="text-sil-red mb-4">{error}</p>}

        {subs?.length > 0 && (
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by user, license, SuiteKey, Ministry ID, or status…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4"
          />
        )}
        {subs?.length > 0 && visibleSubs.length === 0 && (
          <p className="text-gray-400 mb-4">No subscriptions match "{search}".</p>
        )}

        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-gray-400 border-b">
              <tr>
                <th className="p-3">User</th>
                <th className="p-3">License</th>
                <th className="p-3">Billing</th>
                <th className="p-3">FY</th>
                <th className="p-3">Status</th>
                <th className="p-3">Started</th>
                <th className="p-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visibleSubs?.map(sub => (
                <tr key={sub.id}>
                  <td className="p-3">{sub.user_email}</td>
                  <td className="p-3 font-medium text-brand">{sub.license?.name}</td>
                  <td className="p-3 text-gray-500">{billingLabel(sub)}</td>
                  <td className="p-3 text-gray-500">{fyLabel(sub) || '—'}</td>
                  <td className={`p-3 ${STATUS_COLOR[sub.status]}`}>{STATUS_LABEL[sub.status]}</td>
                  <td className="p-3 text-gray-500 whitespace-nowrap">{sub.start_date}</td>
                  <td className="p-3">
                    {sub.status === 'approved' && (
                      <div className="flex items-center gap-3 whitespace-nowrap">
                        {sub.license?.activation_url && (
                          <a href={sub.license.activation_url} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand">
                            Open vendor portal
                          </a>
                        )}
                        <button onClick={() => handleActivate(sub)} className="text-xs font-medium text-sil-green">Mark active</button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppLayout>
  )
}

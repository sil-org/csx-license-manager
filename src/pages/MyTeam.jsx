import { useEffect, useState } from 'react'
import AppLayout from '../components/AppLayout'
import { getLinks } from '../navLinks'
import { getTeamSubscriptions, getLastTeamImport } from '../lib/team'
import { billingLabel, fyLabel, STATUS_LABEL, STATUS_COLOR } from '../lib/subscriptionDisplay'

export default function MyTeam() {
  const [subs, setSubs] = useState(null)
  const [lastImport, setLastImport] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    getTeamSubscriptions().then(setSubs).catch(e => setError(e.message))
    getLastTeamImport().then(setLastImport).catch(() => {})
  }, [])

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-4xl mx-auto p-6">
        <h1 className="font-display text-2xl font-bold text-brand mb-1">My Team</h1>
        <p className="text-xs text-gray-400 mb-6">
          {lastImport
            ? `Team last imported on ${new Date(lastImport.created_at).toLocaleDateString()}`
            : 'Team hierarchy has never been imported'}
        </p>

        {error && <p className="text-sil-red mb-4">{error}</p>}
        {!subs && !error && <p className="text-gray-400">Loading…</p>}
        {subs?.length === 0 && (
          <p className="text-gray-400">
            No subscriptions to show — this lists licenses used by your direct and indirect reports, and either
            you don't have any on file, or none of them have an active or pending subscription.
          </p>
        )}

        {subs?.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-gray-400 border-b">
                <tr>
                  <th className="p-3">Person</th>
                  <th className="p-3">License</th>
                  <th className="p-3">Billing</th>
                  <th className="p-3">FY</th>
                  <th className="p-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {subs.map(sub => (
                  <tr key={sub.id}>
                    <td className="p-3">{sub.user_email}</td>
                    <td className="p-3 font-medium text-brand">{sub.license?.name}</td>
                    <td className="p-3 text-gray-500">{billingLabel(sub)}</td>
                    <td className="p-3 text-gray-500">{fyLabel(sub) || '—'}</td>
                    <td className={`p-3 ${STATUS_COLOR[sub.status]}`}>{STATUS_LABEL[sub.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppLayout>
  )
}

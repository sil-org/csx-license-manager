import { useEffect, useState } from 'react'
import AppLayout from '../components/AppLayout'
import { getLinks } from '../navLinks'
import { getMySuiteKeyCharges } from '../lib/suiteKeyCharges'
import { fyLabel, STATUS_LABEL, STATUS_COLOR } from '../lib/subscriptionDisplay'

// Mirrors Managers.gs's "SuiteKey Charges" tab — every charge to any SuiteKey
// you own, not just the ones currently awaiting your approval (that's what
// /action-center is for). Not role-gated, same convention as Action Center/My Team:
// empty unless you own at least one SuiteKey.
export default function SuiteKeyCharges() {
  const [charges, setCharges] = useState(null)
  const [ownedKeys, setOwnedKeys] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    getMySuiteKeyCharges()
      .then(({ charges, ownedKeys }) => { setCharges(charges); setOwnedKeys(ownedKeys) })
      .catch(e => setError(e.message))
  }, [])

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-4xl mx-auto p-6">
        <h1 className="font-display text-2xl font-bold text-brand mb-1">SuiteKey Charges</h1>
        {ownedKeys.length > 0 && (
          <p className="text-sm text-gray-500 mb-6">SuiteKey{ownedKeys.length === 1 ? '' : 's'}: {ownedKeys.join(', ')}</p>
        )}

        {error && <p className="text-sil-red mb-4">{error}</p>}
        {!charges && !error && <p className="text-gray-400">Loading…</p>}
        {charges?.length === 0 && (
          <p className="text-gray-400">
            Nothing to show — you don't own any SuiteKeys on file, or none have a charge against them yet.
          </p>
        )}

        {charges?.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-gray-400 border-b">
                <tr>
                  <th className="p-3">SuiteKey</th>
                  <th className="p-3">User</th>
                  <th className="p-3">License</th>
                  <th className="p-3">FY</th>
                  <th className="p-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {charges.map(sub => (
                  <tr key={sub.id}>
                    <td className="p-3 font-medium text-brand">{sub.suite_key}</td>
                    <td className="p-3">{sub.user_email}</td>
                    <td className="p-3">{sub.license?.name}</td>
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

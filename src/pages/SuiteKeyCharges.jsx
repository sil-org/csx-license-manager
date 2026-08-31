import { useEffect, useState } from 'react'
import { XCircle } from 'lucide-react'
import AppLayout from '../components/AppLayout'
import { getLinks } from '../navLinks'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { getMySuiteKeyCharges } from '../lib/suiteKeyCharges'
import { revokeSubscription } from '../lib/approvals'
import { sendEmail, revokedEmailSubject, revokedEmailHtml } from '../lib/email'
import { fyLabel, STATUS_LABEL, STATUS_COLOR } from '../lib/subscriptionDisplay'

// Mirrors Managers.gs's "SuiteKey Charges" tab — every charge to any SuiteKey
// you own, not just the ones currently awaiting your approval (that's what
// /action-center is for). Not role-gated, same convention as Action Center/My Team:
// empty unless you own at least one SuiteKey.
export default function SuiteKeyCharges() {
  const { profile } = useAuth()
  const [charges, setCharges] = useState(null)
  const [ownedKeys, setOwnedKeys] = useState([])
  const [error, setError] = useState(null)

  function reload() {
    getMySuiteKeyCharges()
      .then(({ charges, ownedKeys }) => { setCharges(charges); setOwnedKeys(ownedKeys) })
      .catch(e => setError(e.message))
  }

  useEffect(reload, [])

  // Mirrors Approvals.gs's revokeSubscription() — pulls back a previously
  // active subscription charged to a key this user owns. Unlike cancelling a
  // still-pending request (handled via Action Center's approve/decline),
  // revoking always notifies the seat holder: it's taking away something
  // they already have.
  async function handleRevoke(sub) {
    const reason = window.prompt(`Revoke ${sub.license?.name} for ${sub.user_email}? Optionally add a reason (shown to them):`)
    if (reason === null) return
    try {
      const notify = await revokeSubscription(sub.id, reason)
      reload()
      for (const n of notify || []) {
        try {
          await sendEmail({
            to: n.to,
            subject: revokedEmailSubject(n.licenseName),
            html: revokedEmailHtml({ sub: n.sub, licenseName: n.licenseName, performedBy: profile?.primary_email, reason: n.reason }),
            template: 'revoked',
            subscriptionId: sub.id,
          })
        } catch (err) {
          console.error('revoked email failed:', err.message)
        }
      }
      // Nudges sync-provisioning to reconcile (deprovision) now instead of
      // waiting for its next scheduled run — best effort, the schedule is
      // the correctness backstop if this fails.
      supabase.functions.invoke('sync-provisioning').catch(err => console.error('provisioning sync kick failed:', err.message))
      // Removes sub.user_email from the license's Google Group, if it has
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
                  <th className="p-3">Actions</th>
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
                    <td className="p-3">
                      {sub.status === 'active' && (
                        <button onClick={() => handleRevoke(sub)} title="Revoke subscription" className="p-1 rounded hover:bg-gray-100 text-sil-red">
                          <XCircle size={16} />
                        </button>
                      )}
                    </td>
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

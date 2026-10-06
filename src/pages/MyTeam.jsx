import { useEffect, useMemo, useState } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown, XCircle } from 'lucide-react'
import AppLayout from '../components/AppLayout'
import TeamSpendCard from '../components/TeamSpendCard'
import { getLinks } from '../navLinks'
import { useAuth } from '../context/AuthContext'
import { getTeamSubscriptions, getLastTeamImport } from '../lib/team'
import { supabase } from '../lib/supabase'
import { cancelSubscription } from '../lib/subscriptions'
import { sendEmail, cancelledEmailSubject, cancelledEmailHtml } from '../lib/email'
import { billingLabel, fyLabel, STATUS_LABEL, STATUS_COLOR, INACTIVE_STATUSES } from '../lib/subscriptionDisplay'

// Same column/sort pattern as Admin -> All Subscriptions' COLUMNS, so the
// header-click handler stays generic instead of a big per-column switch.
const COLUMNS = [
  { key: 'user_email', label: 'Person', sort: s => s.user_email.toLowerCase() },
  { key: 'license', label: 'License', sort: s => (s.license?.name || '').toLowerCase() },
  { key: 'billing', label: 'Billing', sort: s => billingLabel(s).toLowerCase() },
  { key: 'fy', label: 'FY', sort: s => s.fy || 0 },
  { key: 'status', label: 'Status', sort: s => STATUS_LABEL[s.status] || s.status },
]

// Statuses cancel_subscription() will actually accept — mirrors the same
// list in MySubscriptions.jsx/AllSubscriptions.jsx. A manager cancelling a
// report's subscription is authorized server-side by is_manager_of() (see
// 57_manager_and_suite_key_owner_revoke.sql).
const CANCELLABLE = ['pending', 'pending_sk_verification', 'approved', 'active']

export default function MyTeam() {
  const { profile } = useAuth()
  const [subs, setSubs] = useState(null)
  const [lastImport, setLastImport] = useState(null)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [hideInactive, setHideInactive] = useState(true)
  const [sortKey, setSortKey] = useState('user_email')
  const [sortDir, setSortDir] = useState('asc')

  function reload() {
    if (!profile) return
    getTeamSubscriptions(profile.primary_email).then(setSubs).catch(e => setError(e.message))
  }

  useEffect(() => {
    reload()
    getLastTeamImport().then(setLastImport).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile])

  // Same shape as Admin -> All Subscriptions' handleCancel: always non-silent
  // (this is never "cancelling my own subscription" in the self-serve sense,
  // even for the manager's own row — that's My Subscriptions), with an
  // optional reason shown to the person whose subscription this is.
  async function handleCancel(sub) {
    const reason = window.prompt(`Cancel ${sub.license?.name} for ${sub.user_email}? Optionally add a reason (shown to them):`)
    if (reason === null) return
    try {
      const notify = await cancelSubscription(sub.id, reason)
      reload()
      for (const n of notify || []) {
        try {
          await sendEmail({
            to: n.to,
            subject: cancelledEmailSubject(n.licenseName),
            html: cancelledEmailHtml({ sub: n.sub, licenseName: n.licenseName, performedBy: profile?.primary_email, reason: n.reason }),
            template: 'cancelled',
            subscriptionId: sub.id,
          })
        } catch (err) {
          console.error('cancelled email failed:', err.message)
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

  function handleSort(key) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const q = search.trim().toLowerCase()
  const textFiltered = !q ? subs : subs?.filter(s =>
    s.user_email.toLowerCase().includes(q) ||
    (s.license?.name || '').toLowerCase().includes(q) ||
    billingLabel(s).toLowerCase().includes(q) ||
    (STATUS_LABEL[s.status] || s.status).toLowerCase().includes(q)
  )
  const statusFiltered = !hideInactive ? textFiltered : textFiltered?.filter(s => !INACTIVE_STATUSES.includes(s.status))

  const visibleSubs = useMemo(() => {
    if (!statusFiltered) return statusFiltered
    const col = COLUMNS.find(c => c.key === sortKey)
    const sorted = [...statusFiltered].sort((a, b) => {
      const av = col.sort(a), bv = col.sort(b)
      return av < bv ? -1 : av > bv ? 1 : 0
    })
    return sortDir === 'desc' ? sorted.reverse() : sorted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFiltered, sortKey, sortDir])

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-4xl mx-auto p-6">
        <h1 className="font-display text-2xl font-bold text-brand mb-1">My Team</h1>
        <p className="text-xs text-gray-400 mb-6">
          {lastImport
            ? `Team last imported on ${new Date(lastImport.created_at).toLocaleDateString()}`
            : 'Team hierarchy has never been imported'}
        </p>

        <TeamSpendCard />

        {error && <p className="text-sil-red mb-4">{error}</p>}
        {!subs && !error && <p className="text-gray-400">Loading…</p>}
        {subs?.length === 0 && (
          <p className="text-gray-400">
            No subscriptions to show — this lists licenses used by you and your direct and indirect reports, and
            either you don't have any reports on file, or none of you have a subscription.
          </p>
        )}

        {subs?.length > 0 && (
          <>
            <div className="flex items-center gap-3 mb-4">
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Filter by person, license, billing, or status…"
                className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
              <label className="flex items-center gap-2 text-sm text-gray-500 whitespace-nowrap">
                <input type="checkbox" checked={hideInactive} onChange={e => setHideInactive(e.target.checked)} />
                Hide cancelled/declined/revoked
              </label>
            </div>

            {visibleSubs.length === 0 && (
              <p className="text-gray-400 mb-4">No subscriptions match the current filters.</p>
            )}

            <div className="bg-white rounded-xl shadow-xs overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-gray-400 border-b">
                  <tr>
                    {COLUMNS.map(col => (
                      <th key={col.key} className="p-3">
                        <button
                          onClick={() => handleSort(col.key)}
                          className="flex items-center gap-1 font-semibold uppercase text-xs tracking-wide hover:text-gray-600"
                        >
                          {col.label}
                          {sortKey === col.key
                            ? (sortDir === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} />)
                            : <ChevronsUpDown size={13} className="text-gray-300" />}
                        </button>
                      </th>
                    ))}
                    <th className="p-3 font-semibold uppercase text-xs tracking-wide">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {visibleSubs.map(sub => (
                    <tr key={sub.id}>
                      <td className="p-3">
                        {sub.user_email}
                        {sub.user_email.toLowerCase() === profile?.primary_email?.toLowerCase() && (
                          <span className="text-gray-400"> (you)</span>
                        )}
                      </td>
                      <td className="p-3 font-medium text-brand">{sub.license?.name}</td>
                      <td className="p-3 text-gray-500">{billingLabel(sub)}</td>
                      <td className="p-3 text-gray-500">{fyLabel(sub) || '—'}</td>
                      <td className={`p-3 ${STATUS_COLOR[sub.status]}`}>{STATUS_LABEL[sub.status]}</td>
                      <td className="p-3">
                        {CANCELLABLE.includes(sub.status) && (
                          <button onClick={() => handleCancel(sub)} title="Cancel subscription" className="p-1 rounded-sm hover:bg-gray-100 text-sil-red">
                            <XCircle size={16} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  )
}

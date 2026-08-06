import { useEffect, useMemo, useState } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import AppLayout from '../../components/AppLayout'
import AdminTabs from '../../components/AdminTabs'
import { getLinks } from '../../navLinks'
import { getAllSubscriptions } from '../../lib/admin'
import { activateSubscription } from '../../lib/approvals'
import { resendApprovalRequest } from '../../lib/subscriptions'
import { supabase } from '../../lib/supabase'
import { sendEmail, activationEmailSubject, activationEmailHtml, approvalRequestEmailSubject, approvalRequestEmailHtml } from '../../lib/email'
import { billingLabel, fyLabel, STATUS_LABEL, STATUS_COLOR } from '../../lib/subscriptionDisplay'

// Each column's sort() returns a directly-comparable value — same pattern as
// Admin -> Catalog's COLUMNS, so the header-click handler stays generic
// instead of a big per-column switch statement.
const COLUMNS = [
  { key: 'user_email', label: 'User', sort: s => s.user_email.toLowerCase() },
  { key: 'license', label: 'License', sort: s => (s.license?.name || '').toLowerCase() },
  { key: 'billing', label: 'Billing', sort: s => billingLabel(s).toLowerCase() },
  { key: 'fy', label: 'FY', sort: s => s.fy || 0 },
  { key: 'status', label: 'Status', sort: s => STATUS_LABEL[s.status] || s.status },
  { key: 'started', label: 'Provisioned', sort: s => s.activated_at || '' },
]

// Mirrors GAS's Admin Panel "All Subscriptions" tab — every subscription,
// every user, every status, unfiltered. Admin: SuiteKey Charges/My Team are
// scoped to what you own/manage; this is the one place to see everything.
export default function AdminAllSubscriptions() {
  const [subs, setSubs] = useState(null)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [sortKey, setSortKey] = useState('started')
  const [sortDir, setSortDir] = useState('desc')
  const [resendState, setResendState] = useState({})
  const [priceInputs, setPriceInputs] = useState({})

  function reload() {
    getAllSubscriptions().then(setSubs).catch(e => setError(e.message))
  }

  useEffect(reload, [])

  function handleSort(key) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  // Mirrors handleActivate() in Approvals.jsx — duplicated rather than shared
  // since that page's version is tied to its own provisioning-queue reload.
  async function handleActivate(sub) {
    const priceInput = priceInputs[sub.id]
    const price = priceInput?.trim() ? Number(priceInput) : null
    try {
      await activateSubscription(sub.id, price)
      reload()
      try {
        await sendEmail({
          to: sub.user_email,
          subject: activationEmailSubject(sub.license?.name),
          html: activationEmailHtml({ sub, licenseName: sub.license?.name, onboardingMessage: sub.license?.onboarding_message, moreInfoUrl: sub.license?.more_info_url }),
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

  // Covers the case where a pending request's original owner-notification
  // email never went out (see request-for-others RLS gap in requestSubscription()).
  async function handleResendApproval(sub) {
    setResendState(s => ({ ...s, [sub.id]: 'sending' }))
    try {
      const notify = await resendApprovalRequest(sub)
      if (!notify) throw new Error('SuiteKey has no owner on file')
      await sendEmail({
        to: notify.to,
        bcc: notify.bcc,
        subject: approvalRequestEmailSubject(notify.suiteKey),
        html: approvalRequestEmailHtml(notify),
        template: 'approval_request',
        subscriptionId: sub.id,
      })
      setResendState(s => ({ ...s, [sub.id]: 'sent' }))
    } catch (err) {
      console.error('resend approval request failed:', err.message)
      setResendState(s => ({ ...s, [sub.id]: 'failed' }))
    }
  }

  const q = search.trim().toLowerCase()
  const textFiltered = !q ? subs : subs?.filter(s =>
    s.user_email.toLowerCase().includes(q) ||
    (s.license?.name || '').toLowerCase().includes(q) ||
    (s.suite_key || '').toLowerCase().includes(q) ||
    (s.ministry_id || '').toLowerCase().includes(q) ||
    s.status.toLowerCase().includes(q)
  )
  const statusFiltered = !statusFilter ? textFiltered : textFiltered?.filter(s => s.status === statusFilter)

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
      <div className="max-w-6xl mx-auto p-6">
        <AdminTabs />
        <h1 className="font-display text-2xl font-bold text-brand mb-6">Admin — All Subscriptions</h1>
        {error && <p className="text-sil-red mb-4">{error}</p>}

        {subs?.length > 0 && (
          <div className="flex gap-3 mb-4">
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Filter by user, license, SuiteKey, or Ministry ID…"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">All statuses</option>
              {Object.entries(STATUS_LABEL).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
        )}
        {subs?.length > 0 && visibleSubs.length === 0 && (
          <p className="text-gray-400 mb-4">No subscriptions match the current filters.</p>
        )}

        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
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
                  <td className="p-3 text-gray-500 whitespace-nowrap">{sub.activated_at || '—'}</td>
                  <td className="p-3">
                    {sub.status === 'approved' && (
                      <div className="flex items-center gap-3 whitespace-nowrap">
                        {sub.license?.activation_url && (
                          <a href={sub.license.activation_url} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand">
                            Open vendor portal
                          </a>
                        )}
                        <input
                          type="number" step="0.01" min="0" placeholder="Price paid"
                          value={priceInputs[sub.id] ?? ''}
                          onChange={e => setPriceInputs(p => ({ ...p, [sub.id]: e.target.value }))}
                          className="w-20 border border-gray-300 rounded-lg px-2 py-1 text-xs"
                        />
                        <button onClick={() => handleActivate(sub)} className="text-xs font-medium text-sil-green">Mark active</button>
                      </div>
                    )}
                    {sub.status === 'pending' && sub.suite_key && (
                      resendState[sub.id] === 'sent' ? (
                        <span className="text-xs text-sil-green">Sent</span>
                      ) : resendState[sub.id] === 'failed' ? (
                        <span className="text-xs text-sil-red">Failed — check owner on file</span>
                      ) : (
                        <button
                          onClick={() => handleResendApproval(sub)}
                          disabled={resendState[sub.id] === 'sending'}
                          className="text-xs font-medium text-brand disabled:opacity-50"
                        >
                          {resendState[sub.id] === 'sending' ? 'Sending…' : 'Resend owner notification'}
                        </button>
                      )
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

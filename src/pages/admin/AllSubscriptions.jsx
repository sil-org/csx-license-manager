import { useEffect, useMemo, useState } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown, StickyNote, X, RefreshCw, XCircle, CheckCircle2, Bell, ExternalLink } from 'lucide-react'
import AppLayout from '../../components/AppLayout'
import AdminTabs from '../../components/AdminTabs'
import { getLinks } from '../../navLinks'
import { useAuth } from '../../context/AuthContext'
import { getAllSubscriptions, searchSubscriptions, getLicenseOptions, getSubscriptionFyOptions } from '../../lib/admin'
import { activateSubscription } from '../../lib/approvals'
import { searchSuiteKeys } from '../../lib/suiteKeys'
import {
  resendApprovalRequest, resendSkVerification, resendProvisioningRequest, cancelSubscription, buildRenewalReminderNotification,
  updateSubscriptionDetails, updateSubscriptionSuiteKey, optInRenewal, optOutRenewal,
} from '../../lib/subscriptions'
import { supabase } from '../../lib/supabase'
import {
  sendEmail, activationEmailSubject, activationEmailHtml, approvalRequestEmailSubject, approvalRequestEmailHtml,
  provisioningRequiredEmailSubject, provisioningRequiredEmailHtml, cancelledEmailSubject, cancelledEmailHtml,
  renewalReminderEmailSubject, renewalReminderEmailHtml, renewalReminderCardHtml, renewalPriceLabel,
  skVerificationEmailSubject, skVerificationEmailHtml,
} from '../../lib/email'
import { billingLabel, fyLabel, nextRenewalLabel, STATUS_LABEL, STATUS_COLOR } from '../../lib/subscriptionDisplay'
import { downloadCsv } from '../../lib/csv'

// Gates the bell "resend this reminder" icon: only while there's an actual
// open renewal period (started via Admin -> Catalog's "Start renewal
// period") does resending make sense. GTIS-sponsored subscriptions are
// excluded outright — GTIS foots the whole bill, so there's never a
// renew/cancel decision for the seat holder to make (unlike department-gated,
// which is free per-seat but still opt-in per-license via renewal_reminder —
// see 48_gemini_renewal_reminder_fix.sql).
function isRenewalReminderEligible(sub) {
  return sub.status === 'active' && sub.billing_cycle === 'annual' && sub.renewal_reminder
    && sub.open_renewal_fy != null && sub.billing_type !== 'gtis'
}

// Notes column for CSV export: folds extra_field_value in alongside notes
// (e.g. a Shared Drive's name) — same convention get_finance_export() uses
// server-side, since it's often the only record of that answer.
function subscriptionNotes(sub) {
  const extra = sub.extra_field_value
    ? `${sub.license?.extra_field_label || 'Extra field'}: ${sub.extra_field_value}`
    : null
  return [sub.notes, extra].filter(Boolean).join('; ')
}

const CSV_HEADER = ['User', 'License', 'Billing', 'FY', 'Status', 'Provisioned', 'Price paid', 'Product key', 'Invoice #', 'Notes']

function toCsvRow(sub) {
  return [
    sub.user_email, sub.license?.name, billingLabel(sub), fyLabel(sub), STATUS_LABEL[sub.status],
    sub.activated_at, sub.price_at_signup, sub.product_key, sub.invoice_number,
    subscriptionNotes(sub),
  ]
}

// Statuses cancel_subscription() will actually accept — mirrors the same
// list in MySubscriptions.jsx/ActionCenter.jsx.
const CANCELLABLE = ['pending', 'pending_sk_verification', 'approved', 'active']

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
// every user, every status — searched rather than browsed. Admin: SuiteKey
// Charges/My Team are scoped to what you own/manage; this is the one place
// that can reach any subscription, any user.
export default function AdminAllSubscriptions() {
  const { profile } = useAuth()
  const [subs, setSubs] = useState(null)
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [licenseFilter, setLicenseFilter] = useState('')
  const [fyFilter, setFyFilter] = useState('')
  const [licenseOptions, setLicenseOptions] = useState([])
  const [fyOptions, setFyOptions] = useState([])
  const [sortKey, setSortKey] = useState('started')
  const [sortDir, setSortDir] = useState('desc')
  const [resendState, setResendState] = useState({})
  const [editingSub, setEditingSub] = useState(null)
  const [activateMode, setActivateMode] = useState(false)
  const [editForm, setEditForm] = useState({ notes: '', productKey: '', invoiceNumber: '', pricePaid: '', extraFieldValue: '', suiteKey: '', suggestedApproverEmail: '' })
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState(null)
  const [suiteKeySelected, setSuiteKeySelected] = useState(true)
  const [suiteKeySuggestions, setSuiteKeySuggestions] = useState([])
  const [showSuiteKeySuggestions, setShowSuiteKeySuggestions] = useState(false)
  const [exportingAll, setExportingAll] = useState(false)

  const hasFilter = !!(search.trim() || statusFilter || licenseFilter || fyFilter)

  // Re-runs the current search — used both by the debounced effect below and
  // by every mutating action (cancel, save details, record a renewal
  // decision) to refresh in place afterward. No filter set at all means
  // nothing to query: the page starts (and returns to) empty until the
  // admin actually searches for something, rather than loading every
  // subscription up front.
  function reload() {
    if (!hasFilter) { setSubs(null); setTotalCount(0); return }
    setLoading(true)
    searchSubscriptions({ search, status: statusFilter, licenseId: licenseFilter, fy: fyFilter })
      .then(({ rows, count }) => { setSubs(rows); setTotalCount(count) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }

  // Debounced so typing in the search box doesn't fire a query per
  // keystroke; the status/license/FY dropdowns are discrete choices and
  // could fire immediately, but sharing one effect keeps this simple and
  // 300ms is imperceptible for a click.
  useEffect(() => {
    const timer = setTimeout(reload, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, statusFilter, licenseFilter, fyFilter])

  useEffect(() => {
    getLicenseOptions().then(setLicenseOptions).catch(e => setError(e.message))
    getSubscriptionFyOptions().then(setFyOptions).catch(e => setError(e.message))
  }, [])

  async function handleExportAll() {
    setExportingAll(true)
    try {
      const rows = await getAllSubscriptions()
      downloadCsv(CSV_HEADER, rows.map(toCsvRow), `all-subscriptions-${new Date().toISOString().split('T')[0]}.csv`)
    } catch (err) {
      setError(err.message)
    } finally {
      setExportingAll(false)
    }
  }

  // Debounced typeahead for the Details modal's SuiteKey repoint field —
  // mirrors Catalog's request form, since suite_keys is now refreshed daily
  // from the Finance system and a hand-typed key that isn't in that list is
  // a typo rather than a legitimate one.
  useEffect(() => {
    if (!editingSub || !editForm.suiteKey.trim()) { setSuiteKeySuggestions([]); return }
    let cancelled = false
    const timer = setTimeout(() => {
      searchSuiteKeys(editForm.suiteKey)
        .then(results => { if (!cancelled) setSuiteKeySuggestions(results) })
        .catch(() => { if (!cancelled) setSuiteKeySuggestions([]) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [editForm.suiteKey, editingSub])

  function handleSort(key) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
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
        html: approvalRequestEmailHtml({
          suiteKey: notify.suiteKey, licenseName: notify.licenseName,
          userEmail: notify.requesterEmail, recipientEmail: notify.recipientEmail, moreInfoUrl: notify.moreInfoUrl,
          price: notify.price, priceUnit: notify.priceUnit,
        }),
        template: 'approval_request',
        subscriptionId: sub.id,
      })
      setResendState(s => ({ ...s, [sub.id]: 'sent' }))
    } catch (err) {
      console.error('resend approval request failed:', err.message)
      setResendState(s => ({ ...s, [sub.id]: 'failed' }))
    }
  }

  // Covers a pending SuiteKey verification whose original email never
  // reached the suggested approver (bounced, wrong inbox, etc).
  async function handleResendSkVerification(sub) {
    setResendState(s => ({ ...s, [sub.id]: 'sending' }))
    try {
      const notify = resendSkVerification(sub)
      if (!notify) throw new Error('No pending approver on file')
      await sendEmail({
        to: notify.to,
        subject: skVerificationEmailSubject(notify.suiteKey),
        html: skVerificationEmailHtml({
          suiteKey: notify.suiteKey, licenseName: sub.license?.name,
          requesterEmail: profile?.primary_email, recipientEmail: sub.user_email,
          price: sub.license?.price, priceUnit: sub.license?.price_unit,
        }),
        template: 'sk_verification',
        subscriptionId: sub.id,
      })
      setResendState(s => ({ ...s, [sub.id]: 'sent' }))
    } catch (err) {
      console.error('resend sk verification failed:', err.message)
      setResendState(s => ({ ...s, [sub.id]: 'failed' }))
    }
  }

  // Covers a service manager who missed (or never got, e.g. this went
  // active without ever notifying anyone — see the "no license is
  // auto-provisioned yet" fix) the original provisioning-required email.
  function confirmResendProvisioning(sub) {
    if (!window.confirm(`Resend the provisioning-required email for ${sub.license?.name} (${sub.user_email})?`)) return
    handleResendProvisioning(sub)
  }

  async function handleResendProvisioning(sub) {
    setResendState(s => ({ ...s, [sub.id]: 'sending' }))
    try {
      const notifications = await resendProvisioningRequest(sub)
      for (const n of notifications) {
        await sendEmail({
          to: n.to,
          subject: provisioningRequiredEmailSubject({ licenseName: n.licenseName, userEmail: n.sub.user_email }),
          html: provisioningRequiredEmailHtml({
            sub: n.sub, licenseName: n.licenseName, activationUrl: n.activationUrl, userDisplayName: n.userDisplayName,
            jobTitle: n.jobTitle, department: n.department,
            showName: n.showName, showJobTitle: n.showJobTitle, showDepartment: n.showDepartment,
          }),
          template: 'provisioning_required',
          subscriptionId: sub.id,
        })
      }
      setResendState(s => ({ ...s, [sub.id]: 'sent' }))
    } catch (err) {
      console.error('resend provisioning request failed:', err.message)
      setResendState(s => ({ ...s, [sub.id]: 'failed' }))
    }
  }

  // Admins and (per license) service managers can cancel any request from
  // any non-terminal status here — this table is scoped by RLS, so a service
  // manager only ever sees rows they're actually authorized to act on. Always
  // non-silent: acting from this table is never "cancelling my own
  // subscription" in the self-serve sense (that's My Subscriptions).
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
      // See supabase/functions/sync-provisioning/index.ts's header comment.
      supabase.functions.invoke('sync-provisioning', {
        body: { groupMembershipUpdate: { licenseId: sub.license_id, email: sub.user_email, action: 'remove' } },
      }).catch(err => console.error('group membership removal failed:', err.message))
    } catch (err) {
      setError(err.message)
    }
  }

  // Opens the "purchase details" modal (notes/product key/invoice number/price
  // paid) — a single popup instead of inline per-row inputs, since cramming
  // four fields into the table made rows too tall and left no room to see
  // the rest of a row's data. The "Mark active" icon on approved rows opens
  // the same modal in activate mode: saving details also flips the
  // subscription to active instead of just recording the purchase details.
  function openEditModal(sub, { activate = false } = {}) {
    setEditError(null)
    setEditForm({
      notes: sub.notes || '',
      productKey: sub.product_key || '',
      invoiceNumber: sub.invoice_number || '',
      pricePaid: sub.price_at_signup ?? '',
      extraFieldValue: sub.extra_field_value || '',
      suiteKey: sub.suite_key || '',
      suggestedApproverEmail: '',
    })
    setSuiteKeySelected(true)
    setSuiteKeySuggestions([])
    setActivateMode(activate)
    setEditingSub(sub)
  }

  function closeEditModal() {
    setEditingSub(null)
    setActivateMode(false)
    setEditError(null)
  }

  function selectSuiteKeySuggestion(s) {
    setEditForm(f => ({ ...f, suiteKey: s.suite_key }))
    setSuiteKeySelected(true)
    setShowSuiteKeySuggestions(false)
  }

  async function handleSaveDetails(e) {
    e.preventDefault()
    const sub = editingSub
    const newSuiteKey = editForm.suiteKey.trim()
    const suiteKeyChanged = sub.suite_key && newSuiteKey && newSuiteKey.toLowerCase() !== sub.suite_key.toLowerCase()
    if (suiteKeyChanged && !suiteKeySelected) {
      setEditError('Please pick a SuiteKey from the dropdown list.')
      return
    }
    setEditSaving(true)
    setEditError(null)
    try {
      await updateSubscriptionDetails(sub.id, editForm)

      if (suiteKeyChanged) {
        const notify = await updateSubscriptionSuiteKey(sub.id, newSuiteKey, editForm.suggestedApproverEmail.trim())
        if (notify) {
          try {
            if (notify.type === 'sk_verification') {
              await sendEmail({
                to: notify.to,
                subject: skVerificationEmailSubject(notify.suiteKey),
                html: skVerificationEmailHtml({
                  suiteKey: notify.suiteKey, licenseName: sub.license?.name,
                  requesterEmail: profile?.primary_email, recipientEmail: sub.user_email,
                  price: sub.license?.price, priceUnit: sub.license?.price_unit,
                }),
                template: 'sk_verification',
                subscriptionId: sub.id,
              })
            } else {
              await sendEmail({
                to: notify.to,
                subject: approvalRequestEmailSubject(notify.suiteKey),
                html: approvalRequestEmailHtml({
                  suiteKey: notify.suiteKey, licenseName: sub.license?.name,
                  userEmail: sub.user_email, moreInfoUrl: sub.license?.more_info_url,
                  price: sub.license?.price, priceUnit: sub.license?.price_unit,
                }),
                template: 'approval_request',
                subscriptionId: sub.id,
              })
            }
          } catch (err) {
            console.error('suite key change notification failed:', err.message)
          }
        }
      }

      if (activateMode) {
        await activateSubscription(sub.id, null)
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
        // Adds sub.user_email to the license's Google Group, if it has one —
        // a single targeted add, never a full-membership resync.
        supabase.functions.invoke('sync-provisioning', {
          body: { groupMembershipUpdate: { licenseId: sub.license_id, email: sub.user_email, action: 'add' } },
        }).catch(err => console.error('group membership add failed:', err.message))
      }
      closeEditModal()
      reload()
    } catch (err) {
      setEditError(err.message)
    } finally {
      setEditSaving(false)
    }
  }

  // Manually triggers a single-subscription renewal reminder — the "initial"
  // send (issue #3: renewal notices should reach both the target account and
  // the original requester, CC'd, when different). A weekly job that does
  // this automatically for every eligible subscription is separate,
  // not-yet-built work — see README's "not ported yet" list.
  function confirmSendRenewalReminder(sub) {
    if (!window.confirm(`Send a renewal reminder for ${sub.license?.name} to ${sub.user_email}?`)) return
    handleSendRenewalReminder(sub)
  }

  async function handleSendRenewalReminder(sub) {
    setResendState(s => ({ ...s, [sub.id]: 'sending' }))
    try {
      const notify = await buildRenewalReminderNotification(sub)
      const card = renewalReminderCardHtml({
        licenseName: notify.licenseName,
        suiteKey: billingLabel(sub),
        // The license's current price, not sub.price_at_signup — renewals are
        // billed at full price (see renewalPriceLabel in lib/email.js).
        priceLabel: renewalPriceLabel(sub.license?.price),
        renewalLabel: nextRenewalLabel(sub.renewal_month),
        reminderMessage: sub.license?.reminder_message,
      })
      await sendEmail({
        to: notify.to,
        cc: notify.cc,
        subject: renewalReminderEmailSubject(),
        html: renewalReminderEmailHtml({ cardsHtml: card }),
        template: 'renewal_reminder',
        subscriptionId: sub.id,
      })
      setResendState(s => ({ ...s, [sub.id]: 'sent' }))
    } catch (err) {
      console.error('renewal reminder failed:', err.message)
      setResendState(s => ({ ...s, [sub.id]: 'failed' }))
    }
  }

  // Records a renew/cancel decision an owner reported outside the app (e.g.
  // emailed their answer directly) instead of clicking through MySubscriptions
  // themselves. Same opt_in_renewal()/opt_out_renewal() RPCs that page uses —
  // already admin-authorized for any subscription — so this just adds the
  // missing UI. decided_by ends up as the admin's email, not the owner's:
  // matches how every other admin-performed action here (cancel, resend,
  // etc.) is attributed to whoever actually clicked, not the affected user.
  async function handleRenewalDecision(action, sub, label) {
    if (!window.confirm(`Record "${label}" for ${sub.user_email} (${sub.license?.name}, FY${sub.open_renewal_fy})? Only do this if they told you their decision outside the app.`)) return
    try {
      await action(sub.id)
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

  // Filtering now happens server-side in searchSubscriptions() — subs is
  // already exactly what matches. Sorting still happens here, since it's
  // just reordering the (already-bounded, at most one page's worth of)
  // rows already on hand.
  const visibleSubs = useMemo(() => {
    if (!subs) return subs
    const col = COLUMNS.find(c => c.key === sortKey)
    const sorted = [...subs].sort((a, b) => {
      const av = col.sort(a), bv = col.sort(b)
      return av < bv ? -1 : av > bv ? 1 : 0
    })
    return sortDir === 'desc' ? sorted.reverse() : sorted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subs, sortKey, sortDir])

  // Exports whatever the search currently returned — same "respects the
  // filters" convention as Audit Log's export, just against the search
  // results instead of a fully-preloaded table (see handleExportAll above
  // for a true unfiltered export).
  function handleExportCsv() {
    downloadCsv(CSV_HEADER, (visibleSubs || []).map(toCsvRow), `all-subscriptions-${new Date().toISOString().split('T')[0]}.csv`)
  }

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-7xl mx-auto p-6">
        <AdminTabs />
        <h1 className="font-display text-2xl font-bold text-brand mb-6">Admin — All Subscriptions</h1>
        {error && <p className="text-sil-red mb-4">{error}</p>}

        <div className="flex flex-wrap gap-3 mb-4">
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by user, license, SuiteKey, or Ministry ID…"
            className="flex-1 min-w-[240px] border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <select
            value={licenseFilter}
            onChange={e => setLicenseFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All licenses</option>
            {licenseOptions.map(l => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
          <select
            value={fyFilter}
            onChange={e => setFyFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All FYs</option>
            {fyOptions.map(fy => (
              <option key={fy} value={String(fy)}>{`FY${fy}`}</option>
            ))}
          </select>
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
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={!visibleSubs?.length}
            title="Export the rows currently shown (respects the filters above)"
            className="text-sm font-medium text-brand border border-brand rounded-lg px-4 py-2 disabled:opacity-50"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={handleExportAll}
            disabled={exportingAll}
            title="Export every subscription, ignoring the filters above — slower, fetches the whole table"
            className="text-sm font-medium text-gray-500 border border-gray-300 rounded-lg px-4 py-2 disabled:opacity-50"
          >
            {exportingAll ? 'Exporting…' : 'Export all'}
          </button>
        </div>

        {!hasFilter && (
          <p className="text-gray-400 mb-4">Search or choose a filter above to see subscriptions.</p>
        )}
        {hasFilter && loading && (
          <p className="text-gray-400 mb-4">Searching…</p>
        )}
        {hasFilter && !loading && subs?.length === 0 && (
          <p className="text-gray-400 mb-4">No subscriptions match the current filters.</p>
        )}
        {hasFilter && !loading && subs?.length > 0 && totalCount > subs.length && (
          <p className="text-gray-400 mb-4 text-sm">Showing {subs.length} of {totalCount} matches — narrow your search to see the rest.</p>
        )}

        {subs?.length > 0 && (
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
                <th className="p-3 font-semibold uppercase text-xs tracking-wide">Details</th>
                <th className="p-3 font-semibold uppercase text-xs tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visibleSubs?.map(sub => {
                const hasDetails = sub.notes || sub.product_key || sub.invoice_number || sub.extra_field_value
                return (
                <tr key={sub.id} className="hover:bg-gray-50 transition-colors">
                  <td className="p-3">{sub.user_email}</td>
                  <td className="p-3 font-medium text-brand">{sub.license?.name}</td>
                  <td
                    className={`p-3 ${sub.suite_key_row?.deprecated_at ? 'text-sil-red' : 'text-gray-500'}`}
                    title={sub.suite_key_row?.deprecated_at ? 'This SuiteKey has been deprecated' : undefined}
                  >
                    {billingLabel(sub)}
                  </td>
                  <td className="p-3 text-gray-500">{fyLabel(sub) || '—'}</td>
                  <td className={`p-3 ${STATUS_COLOR[sub.status]}`}>{STATUS_LABEL[sub.status]}</td>
                  <td className="p-3 text-gray-500 whitespace-nowrap">{sub.activated_at || '—'}</td>
                  <td className="p-3">
                    <button
                      onClick={() => openEditModal(sub)}
                      title="Notes, product key, invoice number, price paid"
                      className={`p-1 rounded-sm hover:bg-gray-100 ${hasDetails ? 'text-brand' : 'text-gray-300'}`}
                    >
                      <StickyNote size={16} />
                    </button>
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-3 whitespace-nowrap">
                      {sub.status === 'approved' && (
                        <>
                          <button
                            onClick={() => openEditModal(sub, { activate: true })}
                            title="Mark active (opens purchase details)"
                            className="p-1 rounded-sm hover:bg-gray-100 text-sil-green"
                          >
                            <CheckCircle2 size={16} />
                          </button>
                          {resendState[sub.id] === 'sent' ? (
                            <span className="text-xs text-sil-green">Sent</span>
                          ) : resendState[sub.id] === 'failed' ? (
                            <span className="text-xs text-sil-red">Failed</span>
                          ) : (
                            <button
                              onClick={() => confirmResendProvisioning(sub)}
                              disabled={resendState[sub.id] === 'sending'}
                              title="Re-request provisioning"
                              className="p-1 rounded-sm hover:bg-gray-100 text-brand disabled:opacity-50"
                            >
                              <RefreshCw size={16} className={resendState[sub.id] === 'sending' ? 'animate-spin' : ''} />
                            </button>
                          )}
                        </>
                      )}
                      {sub.status === 'pending_sk_verification' && sub.pending_approver_email && (
                        resendState[sub.id] === 'sent' ? (
                          <span className="text-xs text-sil-green">Sent</span>
                        ) : resendState[sub.id] === 'failed' ? (
                          <span className="text-xs text-sil-red">Failed</span>
                        ) : (
                          <button
                            onClick={() => handleResendSkVerification(sub)}
                            disabled={resendState[sub.id] === 'sending'}
                            title="Resend SuiteKey verification email"
                            className="p-1 rounded-sm hover:bg-gray-100 text-brand disabled:opacity-50"
                          >
                            <RefreshCw size={16} className={resendState[sub.id] === 'sending' ? 'animate-spin' : ''} />
                          </button>
                        )
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
                      {isRenewalReminderEligible(sub) && (
                        resendState[sub.id] === 'sent' ? (
                          <span className="text-xs text-sil-green">Sent</span>
                        ) : resendState[sub.id] === 'failed' ? (
                          <span className="text-xs text-sil-red">Failed</span>
                        ) : (
                          <button
                            onClick={() => confirmSendRenewalReminder(sub)}
                            disabled={resendState[sub.id] === 'sending'}
                            title="Send renewal reminder"
                            className="p-1 rounded-sm hover:bg-gray-100 text-brand disabled:opacity-50"
                          >
                            <Bell size={16} className={resendState[sub.id] === 'sending' ? 'animate-spin' : ''} />
                          </button>
                        )
                      )}
                      {CANCELLABLE.includes(sub.status) && (
                        <button onClick={() => handleCancel(sub)} title="Cancel subscription" className="p-1 rounded-sm hover:bg-gray-100 text-sil-red">
                          <XCircle size={16} />
                        </button>
                      )}
                      {sub.open_renewal_fy != null && (
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleRenewalDecision(optInRenewal, sub, 'Renew')}
                            title={`Record that they decided to renew for FY${sub.open_renewal_fy} (e.g. they emailed their answer)`}
                            className="text-xs font-medium text-white bg-sil-green rounded-sm px-2 py-0.5 hover:opacity-90 transition"
                          >
                            Renew
                          </button>
                          <button
                            onClick={() => handleRenewalDecision(optOutRenewal, sub, "Don't renew")}
                            title={`Record that they decided not to renew for FY${sub.open_renewal_fy} (e.g. they emailed their answer)`}
                            className="text-xs font-medium text-white bg-gray-400 rounded-sm px-2 py-0.5 hover:opacity-90 transition"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        )}
      </div>

      {editingSub && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 overflow-y-auto z-50" onClick={closeEditModal}>
          <form onSubmit={handleSaveDetails} onClick={e => e.stopPropagation()} className="bg-white rounded-2xl shadow-lg p-6 max-w-md w-full my-8">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-lg font-bold text-brand">{editingSub.license?.name}</h2>
                {editingSub.license?.activation_url && (
                  <a
                    href={editingSub.license.activation_url} target="_blank" rel="noreferrer"
                    title="Open vendor portal"
                    className="text-gray-400 hover:text-brand"
                  >
                    <ExternalLink size={16} />
                  </a>
                )}
              </div>
              <button type="button" onClick={closeEditModal} aria-label="Close" className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-gray-500 mb-4">{editingSub.user_email}</p>
            {activateMode && (
              <p className="text-sm text-sil-green mb-4">Saving will mark this subscription active and notify the user their license is provisioned.</p>
            )}
            {editError && <p className="text-sil-red text-sm mb-3">{editError}</p>}
            <div className="space-y-3">
              {editingSub.suite_key && (
                <>
                  <div className="relative">
                    <label className="block text-sm text-gray-700 mb-1">SuiteKey</label>
                    <p className="text-xs text-gray-400 mb-1">These are the SuiteKeys available in the Finance System.</p>
                    <input
                      type="text"
                      value={editForm.suiteKey}
                      onChange={e => { setEditForm(f => ({ ...f, suiteKey: e.target.value })); setSuiteKeySelected(false) }}
                      onFocus={() => setShowSuiteKeySuggestions(true)}
                      onBlur={() => setTimeout(() => setShowSuiteKeySuggestions(false), 150)}
                      autoComplete="off"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                    {showSuiteKeySuggestions && suiteKeySuggestions.length > 0 && (
                      <ul className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-md max-h-48 overflow-y-auto">
                        {suiteKeySuggestions.map(s => (
                          <li key={s.suite_key}>
                            <button
                              type="button"
                              onMouseDown={() => selectSuiteKeySuggestion(s)}
                              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 flex items-center justify-between gap-2"
                            >
                              <span className="font-medium text-brand">{s.suite_key}</span>
                              <span className="text-xs text-gray-400 truncate">
                                {s.has_owner ? (s.description || 'Has an owner') : 'No owner yet'}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {editForm.suiteKey.trim().toLowerCase() !== editingSub.suite_key.toLowerCase() && (
                    <label className="block text-sm text-gray-700">
                      Suggested approver (only used if this SuiteKey has no owner on file)
                      <input
                        type="email"
                        value={editForm.suggestedApproverEmail}
                        onChange={e => setEditForm(f => ({ ...f, suggestedApproverEmail: e.target.value }))}
                        className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      />
                      <span className="block text-xs text-gray-400 mt-1">
                        Changing the SuiteKey emails its owner that a request now sits against their key — it does not change this subscription's status.
                      </span>
                    </label>
                  )}
                </>
              )}
              {editingSub.license?.extra_field_label && (
                <label className="block text-sm text-gray-700">
                  {editingSub.license.extra_field_label}
                  <input
                    type="text"
                    value={editForm.extraFieldValue}
                    onChange={e => setEditForm(f => ({ ...f, extraFieldValue: e.target.value }))}
                    className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                </label>
              )}
              <label className="block text-sm text-gray-700">
                Cost at time of purchase
                <input
                  type="number" step="0.01" min="0"
                  value={editForm.pricePaid}
                  onChange={e => setEditForm(f => ({ ...f, pricePaid: e.target.value }))}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-sm text-gray-700">
                Product key
                <input
                  type="text"
                  value={editForm.productKey}
                  onChange={e => setEditForm(f => ({ ...f, productKey: e.target.value }))}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-sm text-gray-700">
                Invoice number
                <input
                  type="text"
                  value={editForm.invoiceNumber}
                  onChange={e => setEditForm(f => ({ ...f, invoiceNumber: e.target.value }))}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-sm text-gray-700">
                Notes
                <textarea
                  rows={4}
                  value={editForm.notes}
                  onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </label>
            </div>
            <div className="flex justify-end gap-3 mt-5">
              <button type="button" onClick={closeEditModal} className="text-sm font-medium text-gray-500">Cancel</button>
              <button
                type="submit"
                disabled={editSaving}
                className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2 hover:bg-brand-dark transition disabled:opacity-50"
              >
                {activateMode ? (editSaving ? 'Marking active…' : 'Mark active') : (editSaving ? 'Saving…' : 'Save')}
              </button>
            </div>
          </form>
        </div>
      )}
    </AppLayout>
  )
}

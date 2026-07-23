import { useEffect, useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import AppLayout from '../components/AppLayout'
import { getLinks } from '../navLinks'
import { useAuth } from '../context/AuthContext'
import { getActiveLicenses } from '../lib/licenses'
import { requestSubscription } from '../lib/subscriptions'
import { searchSuiteKeys } from '../lib/suiteKeys'
import {
  sendEmail,
  skVerificationEmailSubject, skVerificationEmailHtml,
  approvalRequestEmailSubject, approvalRequestEmailHtml,
  approvedPendingEmailSubject, approvedPendingEmailHtml,
  provisioningRequiredEmailSubject, provisioningRequiredEmailHtml,
} from '../lib/email'

// Postgres numeric columns come through supabase-js as strings, hence the
// Number() — whole dollar amounts show with no decimals, anything else
// always shows exactly two (never one, e.g. never "$9.5").
function formatPrice(price) {
  const n = Number(price)
  return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`
}

export default function Catalog() {
  const [licenses, setLicenses] = useState(null)
  const [error, setError] = useState(null)
  const [requesting, setRequesting] = useState(null) // license being requested
  const [search, setSearch] = useState('')
  const [searchParams] = useSearchParams()
  const activeCategory = searchParams.get('category')

  useEffect(() => {
    getActiveLicenses().then(setLicenses).catch(e => setError(e.message))
  }, [])

  const categories = useMemo(
    () => [...new Set((licenses || []).map(l => l.category).filter(Boolean))].sort(),
    [licenses]
  )
  const categoryFiltered = activeCategory
    ? licenses?.filter(l => l.category === activeCategory)
    : licenses
  const q = search.trim().toLowerCase()
  const visibleLicenses = !q ? categoryFiltered : categoryFiltered?.filter(l =>
    l.name.toLowerCase().includes(q) ||
    (l.vendor || '').toLowerCase().includes(q) ||
    (l.category || '').toLowerCase().includes(q)
  )

  return (
    <AppLayout appName="License Manager" links={getLinks({ categories })}>
      <div className="max-w-5xl mx-auto p-6">
        <h1 className="font-display text-2xl font-bold text-brand mb-6">
          License Catalog{activeCategory ? ` — ${activeCategory}` : ''}
        </h1>

        {error && <p className="text-sil-red mb-4">{error}</p>}
        {!licenses && !error && <p className="text-gray-400">Loading…</p>}

        {licenses?.length > 0 && (
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, vendor, or category…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4"
          />
        )}

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleLicenses?.map(license => (
            <div
              key={license.id}
              onClick={() => setRequesting(license)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setRequesting(license) } }}
              role="button"
              tabIndex={0}
              className="bg-white rounded-xl shadow-sm p-5 flex flex-col cursor-pointer hover:shadow-md transition"
            >
              <div className="flex items-start gap-3 mb-3">
                {license.logo_url && (
                  <img src={license.logo_url} alt="" className="h-10 w-10 object-contain flex-shrink-0" />
                )}
                <div>
                  <h2 className="font-semibold text-brand">{license.name}</h2>
                  <p className="text-sm text-gray-500">{license.vendor} &middot; {license.category}</p>
                  {license.price != null && (
                    <p className="text-sm text-gray-700">{formatPrice(license.price)} {license.price_unit}</p>
                  )}
                </div>
              </div>
              <button
                onClick={e => { e.stopPropagation(); setRequesting(license) }}
                className="mt-auto text-sm font-medium bg-brand text-white rounded-lg px-4 py-2 hover:bg-brand-dark transition"
              >
                Request
              </button>
            </div>
          ))}
        </div>

        {visibleLicenses?.length === 0 && (
          <p className="text-gray-400">
            {q
              ? `No licenses match "${search}".`
              : activeCategory ? `No licenses in ${activeCategory}.` : 'No licenses available yet.'}
          </p>
        )}
      </div>

      {requesting && (
        <RequestModal license={requesting} onClose={() => setRequesting(null)} />
      )}
    </AppLayout>
  )
}

// Fires the right notification email(s) for whatever request_subscription() decided,
// mirroring Subscriptions.gs's inline _sendSkVerificationEmail/_sendApprovalRequestEmail/
// _notifySubscriberApprovedPending/_notifyAdminsOfPendingActivation calls. Never lets one
// failed send block the request or the others — same restraint GAS used (try/catch +
// console.error around every MailApp.sendEmail call).
async function notifyForRequest({ notify, id, suiteKey, licenseName, requesterEmail }) {
  for (const n of notify || []) {
    try {
      if (n.type === 'sk_verification') {
        await sendEmail({
          to: n.to,
          subject: skVerificationEmailSubject(suiteKey),
          html: skVerificationEmailHtml({ suiteKey, licenseName, requesterEmail }),
          template: 'sk_verification',
          subscriptionId: id,
        })
      } else if (n.type === 'approval_request') {
        await sendEmail({
          to: n.to,
          subject: approvalRequestEmailSubject(suiteKey),
          html: approvalRequestEmailHtml({ suiteKey, licenseName, userEmail: requesterEmail }),
          template: 'approval_request',
          subscriptionId: id,
        })
      } else if (n.type === 'approved_pending') {
        await sendEmail({
          to: n.to,
          subject: approvedPendingEmailSubject(n.licenseName),
          html: approvedPendingEmailHtml({ sub: n.sub, licenseName: n.licenseName }),
          template: 'approved_pending',
          subscriptionId: id,
        })
      } else if (n.type === 'provisioning_required') {
        await sendEmail({
          to: n.to,
          subject: provisioningRequiredEmailSubject({ licenseName: n.licenseName, userEmail: n.sub.user_email }),
          html: provisioningRequiredEmailHtml({ sub: n.sub, licenseName: n.licenseName, activationUrl: n.activationUrl }),
          template: 'provisioning_required',
          subscriptionId: id,
        })
      }
    } catch (err) {
      console.error(`${n.type} email failed:`, err.message)
    }
  }
}

function RequestModal({ license, onClose }) {
  const { profile } = useAuth()
  const [mode, setMode] = useState('suite_key') // 'suite_key' | 'ministry_id'
  const [suiteKey, setSuiteKey] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestedApproverEmail, setSuggestedApproverEmail] = useState('')
  const [ministryId, setMinistryId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  const fy = new Date().getFullYear()

  // Debounced typeahead — mirrors GAS's searchSuiteKeys(), which searched
  // every SuiteKey regardless of ownership so requesters don't accidentally
  // create a duplicate of one that already exists.
  useEffect(() => {
    if (mode !== 'suite_key' || !suiteKey.trim()) { setSuggestions([]); return }
    let cancelled = false
    const timer = setTimeout(() => {
      searchSuiteKeys(suiteKey)
        .then(results => { if (!cancelled) setSuggestions(results) })
        .catch(() => { if (!cancelled) setSuggestions([]) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [suiteKey, mode])

  function selectSuggestion(s) {
    setSuiteKey(s.suite_key)
    setShowSuggestions(false)
  }

  async function submit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const result = await requestSubscription({
        licenseId: license.id,
        suiteKey: license.gtis_sponsored ? null : mode === 'suite_key' ? suiteKey.trim() : null,
        suggestedApproverEmail: mode === 'suite_key' ? suggestedApproverEmail : null,
        ministryId: mode === 'ministry_id' ? ministryId : null,
        fy,
      })
      await notifyForRequest({
        notify: result.notify,
        id: result.id,
        suiteKey,
        licenseName: license.name,
        requesterEmail: profile?.primary_email,
      })
      setDone(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full">
        <h2 className="font-display text-xl font-bold text-brand mb-1">Request {license.name}</h2>
        <p className="text-sm text-gray-500 mb-6">Fiscal year {fy}</p>

        {done ? (
          <>
            <p className="text-gray-700 mb-6">Your request has been submitted.</p>
            <button onClick={onClose} className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2">Close</button>
          </>
        ) : license.gtis_sponsored ? (
          <form onSubmit={submit}>
            <p className="text-sm text-gray-600 mb-6">This license is GTIS-sponsored — no approval needed.</p>
            {error && <p className="text-sil-red text-sm mb-4">{error}</p>}
            <div className="flex gap-3">
              <button type="submit" disabled={submitting} className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2">
                {submitting ? 'Submitting…' : 'Confirm request'}
              </button>
              <button type="button" onClick={onClose} className="text-sm font-medium text-gray-500">Cancel</button>
            </div>
          </form>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" checked={mode === 'suite_key'} onChange={() => setMode('suite_key')} />
                SuiteKey
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={mode === 'ministry_id'} onChange={() => setMode('ministry_id')} />
                Ministry ID
              </label>
            </div>

            {mode === 'suite_key' ? (
              <>
                <div className="relative">
                  <label className="block text-sm font-medium text-gray-700 mb-1">SuiteKey</label>
                  <input
                    value={suiteKey}
                    onChange={e => setSuiteKey(e.target.value)}
                    onFocus={() => setShowSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                    required
                    autoComplete="off"
                    pattern="[^~]*"
                    title='Cannot contain "~" — check for stray text pasted in after the real key'
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                  {showSuggestions && suggestions.length > 0 && (
                    <ul className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-md max-h-48 overflow-y-auto">
                      {suggestions.map(s => (
                        <li key={s.suite_key}>
                          <button
                            type="button"
                            onMouseDown={() => selectSuggestion(s)}
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
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Suggested approver email <span className="text-gray-400">(only needed if this is a new SuiteKey)</span>
                  </label>
                  <input type="email" value={suggestedApproverEmail} onChange={e => setSuggestedApproverEmail(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                </div>
              </>
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Ministry ID</label>
                <input
                  value={ministryId}
                  onChange={e => setMinistryId(e.target.value)}
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  placeholder="6 digits"
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </div>
            )}

            {error && <p className="text-sil-red text-sm">{error}</p>}

            <div className="flex gap-3 pt-2">
              <button type="submit" disabled={submitting} className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2">
                {submitting ? 'Submitting…' : 'Submit request'}
              </button>
              <button type="button" onClick={onClose} className="text-sm font-medium text-gray-500">Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

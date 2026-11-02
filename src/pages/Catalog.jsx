import { useEffect, useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { X } from 'lucide-react'
import AppLayout from '../components/AppLayout'
import { getLinks } from '../navLinks'
import { useAuth } from '../context/AuthContext'
import { getActiveLicenses, sizeAwareSort } from '../lib/licenses'
import { requestSubscription } from '../lib/subscriptions'
import { searchSuiteKeys } from '../lib/suiteKeys'
import { currentFiscalYear } from '../lib/fiscalYear'
import {
  sendEmail,
  skVerificationEmailSubject, skVerificationEmailHtml,
  approvalRequestEmailSubject, approvalRequestEmailHtml,
  departmentApprovalRequestEmailSubject, departmentApprovalRequestEmailHtml,
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

function billingSummary(license) {
  if (license.billing_cycle === 'monthly') return 'Monthly'
  if (license.billing_cycle === 'one_time') return 'One-time'
  return 'Annual'
}

// Acknowledgement text is admin-authored rich text with plain <a href> links
// (see RichTextEditor in admin/Catalog.jsx, which has no way to set target
// itself) — rewrite them to open in a new tab rather than navigating the
// user away from the acknowledgement they're about to accept.
function openLinksInNewTab(html) {
  if (!html) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('a[href]').forEach(a => {
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
  })
  return doc.body.innerHTML
}

export default function Catalog() {
  const [licenses, setLicenses] = useState(null)
  const [error, setError] = useState(null)
  const [requesting, setRequesting] = useState(null) // license being requested
  const [search, setSearch] = useState('')
  const [searchParams] = useSearchParams()
  const activeCategory = searchParams.get('category')

  useEffect(() => {
    getActiveLicenses()
      .then(data => setLicenses([...data].sort((a, b) => sizeAwareSort(a.name) < sizeAwareSort(b.name) ? -1 : 1)))
      .catch(e => setError(e.message))
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
              className="bg-white rounded-xl shadow-xs p-5 flex flex-col cursor-pointer hover:shadow-md transition"
            >
              <div className="flex items-start gap-3 mb-3">
                {license.logo_url && (
                  <img src={license.logo_url} alt="" className="h-10 w-10 object-contain shrink-0" />
                )}
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="font-semibold text-brand">{license.name}</h2>
                    {license.gtis_sponsored && (
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-sil-green/10 text-sil-green whitespace-nowrap">
                        GTIS Sponsored
                      </span>
                    )}
                  </div>
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
async function notifyForRequest({ notify, id, suiteKey, licenseName, requesterEmail, recipientEmail, moreInfoUrl, price, priceUnit }) {
  for (const n of notify || []) {
    try {
      if (n.type === 'sk_verification') {
        await sendEmail({
          to: n.to,
          subject: skVerificationEmailSubject(suiteKey),
          html: skVerificationEmailHtml({ suiteKey, licenseName, requesterEmail, recipientEmail, price, priceUnit }),
          template: 'sk_verification',
          subscriptionId: id,
        })
      } else if (n.type === 'approval_request') {
        await sendEmail({
          to: n.to,
          bcc: n.bcc,
          subject: approvalRequestEmailSubject(suiteKey),
          html: approvalRequestEmailHtml({ suiteKey, licenseName, userEmail: requesterEmail, recipientEmail, moreInfoUrl, price, priceUnit }),
          template: 'approval_request',
          subscriptionId: id,
        })
      } else if (n.type === 'department_approval_request') {
        await sendEmail({
          to: n.to,
          subject: departmentApprovalRequestEmailSubject(licenseName),
          html: departmentApprovalRequestEmailHtml({ licenseName, userEmail: requesterEmail, recipientEmail, moreInfoUrl }),
          template: 'department_approval_request',
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
          html: provisioningRequiredEmailHtml({
            sub: n.sub, licenseName: n.licenseName, activationUrl: n.activationUrl, userDisplayName: n.userDisplayName,
            jobTitle: n.jobTitle, department: n.department,
            showName: n.showName, showJobTitle: n.showJobTitle, showDepartment: n.showDepartment,
          }),
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
  const { profile, session } = useAuth()
  // Falls back to the auth session's email if the profile row hasn't
  // resolved yet — better than silently emailing "undefined" as the requester.
  const myEmail = profile?.primary_email || session?.user?.email || ''
  const [recipientEmail, setRecipientEmail] = useState(myEmail)
  const [mode, setMode] = useState('suite_key') // 'suite_key' | 'ministry_id'
  const [suiteKey, setSuiteKey] = useState('')
  const [suiteKeyHasOwner, setSuiteKeyHasOwner] = useState(false)
  const [suiteKeySelected, setSuiteKeySelected] = useState(false)
  const [suggestions, setSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [suggestedApproverEmail, setSuggestedApproverEmail] = useState('')
  const [ministryId, setMinistryId] = useState('')
  const [extraFieldValue, setExtraFieldValue] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  // Requesters may charge the current fiscal year or the next one (e.g. in
  // September, for a charge that should land in the coming FY). The server
  // accepts any p_fy.
  const currentFy = currentFiscalYear()
  const [fy, setFy] = useState(currentFy)
  const forSomeoneElse = recipientEmail.trim().toLowerCase() !== myEmail.toLowerCase()

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
    setSuiteKeyHasOwner(s.has_owner)
    setSuiteKeySelected(true)
    if (s.has_owner) setSuggestedApproverEmail('')
    setShowSuggestions(false)
  }

  async function submit(e) {
    e.preventDefault()
    // The suite_keys table is now refreshed daily from the Finance system,
    // so a SuiteKey that doesn't already appear in the dropdown isn't a
    // legitimate new key — it's a typo. Require an actual pick rather than
    // letting request_subscription() silently insert whatever was typed.
    if (mode === 'suite_key' && !license.gtis_sponsored && !license.department_gated && !suiteKeySelected) {
      setError('Please pick a SuiteKey from the dropdown list.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await requestSubscription({
        licenseId: license.id,
        suiteKey: license.gtis_sponsored || license.department_gated ? null : mode === 'suite_key' ? suiteKey.trim() : null,
        suggestedApproverEmail: mode === 'suite_key' ? suggestedApproverEmail : null,
        ministryId: mode === 'ministry_id' ? ministryId : null,
        fy,
        recipientEmail: recipientEmail.trim(),
        extraFieldValue: license.extra_field_label ? extraFieldValue.trim() : null,
        acknowledged,
      })
      await notifyForRequest({
        notify: result.notify,
        id: result.id,
        suiteKey,
        licenseName: license.name,
        requesterEmail: myEmail,
        recipientEmail: recipientEmail.trim(),
        moreInfoUrl: license.more_info_url,
        price: license.price,
        priceUnit: license.price_unit,
      })
      setDone(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 overflow-y-auto">
      {/* min-h-full (not items-center alone) on this inner flex wrapper so a
          modal taller than the viewport scrolls from its true top instead of
          being clipped by flex centering against a fixed-height container. */}
      <div className="min-h-full flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-lg p-6 max-w-md w-full my-8">
          <div className="flex items-start justify-between mb-4">
            <h2 className="font-display text-xl font-bold text-brand">Request {license.name}</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600 -mt-1 -mr-1 p-1">
              <X size={20} />
            </button>
          </div>
  
          {done ? (
            <>
              <p className="text-gray-700 mb-6">
                {forSomeoneElse ? `Your request for ${recipientEmail.trim()} has been submitted.` : 'Your request has been submitted.'}
              </p>
              <button onClick={onClose} className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2">Close</button>
            </>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {(license.notes || license.more_info_url) && (
                <div className="bg-gray-50 rounded-lg px-4 py-3 space-y-2">
                  {license.notes && (
                    <div className="text-sm text-gray-700 [&_a]:text-brand [&_a]:underline" dangerouslySetInnerHTML={{ __html: openLinksInNewTab(license.notes) }} />
                  )}
                  {license.more_info_url && (
                    <a href={license.more_info_url} target="_blank" rel="noreferrer" className="text-sm font-medium text-brand inline-block">
                      More information →
                    </a>
                  )}
                </div>
              )}
              {license.price != null && (
                <div className="bg-gray-50 rounded-lg px-4 py-3">
                  <p className="text-lg font-semibold text-gray-900">{formatPrice(license.price)}</p>
                </div>
              )}
              <p className="text-sm text-gray-500 -mt-2">Billing: {billingSummary(license)}</p>

              <div>
                <label htmlFor="request-fy" className="block text-sm font-medium text-gray-700 mb-1">
                  Fiscal year to be charged
                </label>
                <select
                  id="request-fy"
                  value={fy}
                  onChange={e => setFy(Number(e.target.value))}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                >
                  <option value={currentFy}>FY{currentFy} (current: Oct 1, {currentFy - 1} – Sep 30, {currentFy})</option>
                  <option value={currentFy + 1}>FY{currentFy + 1} (next: Oct 1, {currentFy} – Sep 30, {currentFy + 1})</option>
                </select>
              </div>
  
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  License for <span className="text-sil-red">*</span>
                </label>
                <input
                  type="email"
                  required
                  value={recipientEmail}
                  onChange={e => setRecipientEmail(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
                <p className="text-xs text-gray-400 mt-1">Pre-filled with your email. Change this to request on behalf of someone else.</p>
              </div>
  
              {license.extra_field_label && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {license.extra_field_label} {license.extra_field_required && <span className="text-sil-red">*</span>}
                  </label>
                  <input
                    type="text"
                    required={license.extra_field_required}
                    value={extraFieldValue}
                    onChange={e => setExtraFieldValue(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
              )}
  
              {license.gtis_sponsored ? (
                <p className="text-sm text-gray-600">This license is GTIS-sponsored — no approval needed.</p>
              ) : license.department_gated ? (
                <p className="text-sm text-gray-600">This is a free license — whether it needs approval depends on your department, and is handled automatically.</p>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Bill to <span className="text-sil-red">*</span>
                    </label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setMode('suite_key')}
                        className={`flex-1 text-sm font-medium rounded-lg px-3 py-2 border transition ${
                          mode === 'suite_key' ? 'bg-brand text-white border-brand' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        SuiteKey
                      </button>
                      <button
                        type="button"
                        onClick={() => setMode('ministry_id')}
                        className={`flex-1 text-sm font-medium rounded-lg px-3 py-2 border transition ${
                          mode === 'ministry_id' ? 'bg-brand text-white border-brand' : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        Ministry Account
                      </button>
                    </div>
                  </div>
  
                  {mode === 'suite_key' ? (
                    <>
                      <div className="relative">
                        <label className="block text-sm font-medium text-gray-700 mb-1">
                          SuiteKey <span className="text-sil-red">*</span>
                        </label>
                        <p className="text-xs text-gray-400 mb-1">These are the SuiteKeys available in the Finance System.</p>
                        <input
                          value={suiteKey}
                          onChange={e => { setSuiteKey(e.target.value); setSuiteKeyHasOwner(false); setSuiteKeySelected(false) }}
                          onFocus={() => setShowSuggestions(true)}
                          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                          required
                          autoComplete="off"
                          placeholder="Type at least 2 characters…"
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
                      {!suiteKeyHasOwner && (
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-1">
                            Suggested approver email <span className="text-gray-400">(only needed if this SuiteKey has no owner on file)</span>
                          </label>
                          <input type="email" value={suggestedApproverEmail} onChange={e => setSuggestedApproverEmail(e.target.value)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                        </div>
                      )}
                    </>
                  ) : (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Ministry ID <span className="text-sil-red">*</span>
                      </label>
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
                </>
              )}
  
              {license.requires_acknowledgement && (
                <div className="bg-gray-50 rounded-lg px-4 py-3 space-y-2">
                  {license.acknowledgement_text && (
                    <div className="text-sm text-gray-700 [&_a]:text-brand [&_a]:underline" dangerouslySetInnerHTML={{ __html: openLinksInNewTab(license.acknowledgement_text) }} />
                  )}
                  <label className="flex items-start gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      onChange={e => setAcknowledged(e.target.checked)}
                      required
                      className="mt-0.5"
                    />
                    I have read and agree to the above.
                  </label>
                </div>
              )}
  
              {error && <p className="text-sil-red text-sm">{error}</p>}
  
              <div className="flex justify-end gap-3 border-t border-gray-100 pt-4">
                <button type="button" onClick={onClose} className="text-sm font-medium text-gray-600 border border-gray-300 rounded-lg px-4 py-2 hover:bg-gray-50">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting || (license.requires_acknowledgement && !acknowledged)}
                  className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2 hover:bg-brand-dark transition disabled:opacity-60"
                >
                  {submitting ? 'Submitting…' : license.gtis_sponsored ? 'Confirm request' : 'Submit request'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import NavBar from '../components/NavBar'
import { useAuth } from '../context/AuthContext'
import { getActiveLicenses } from '../lib/licenses'
import { requestSubscription } from '../lib/subscriptions'
import {
  sendEmail,
  skVerificationEmailSubject, skVerificationEmailHtml,
  approvalRequestEmailSubject, approvalRequestEmailHtml,
} from '../lib/email'

export default function Catalog() {
  const [licenses, setLicenses] = useState(null)
  const [error, setError] = useState(null)
  const [requesting, setRequesting] = useState(null) // license being requested

  useEffect(() => {
    getActiveLicenses().then(setLicenses).catch(e => setError(e.message))
  }, [])

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar />
      <div className="max-w-5xl mx-auto p-6">
        <h1 className="font-display text-2xl font-bold text-brand mb-6">License Catalog</h1>

        {error && <p className="text-sil-red mb-4">{error}</p>}
        {!licenses && !error && <p className="text-gray-400">Loading…</p>}

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {licenses?.map(license => (
            <div key={license.id} className="bg-white rounded-xl shadow-sm p-5 flex flex-col">
              {license.logo_url && <img src={license.logo_url} alt="" className="h-8 mb-3 object-contain" />}
              <h2 className="font-semibold text-brand">{license.name}</h2>
              <p className="text-sm text-gray-500 mb-1">{license.vendor} &middot; {license.category}</p>
              {license.price != null && (
                <p className="text-sm text-gray-700 mb-3">
                  ${license.price} {license.price_unit}
                </p>
              )}
              <button
                onClick={() => setRequesting(license)}
                className="mt-auto text-sm font-medium bg-brand text-white rounded-lg px-4 py-2 hover:bg-brand-dark transition"
              >
                Request
              </button>
            </div>
          ))}
        </div>

        {licenses?.length === 0 && <p className="text-gray-400">No licenses available yet.</p>}
      </div>

      {requesting && (
        <RequestModal license={requesting} onClose={() => setRequesting(null)} />
      )}
    </div>
  )
}

// Fires the right notification email for whatever request_subscription() decided,
// mirroring Subscriptions.gs's inline _sendSkVerificationEmail/_sendApprovalRequestEmail
// calls. Never lets a failed send block the request itself — same restraint GAS used
// (try/catch + console.error around every MailApp.sendEmail call).
async function notifyForRequest({ notify, id, suiteKey, licenseName, requesterEmail }) {
  if (!notify) return
  try {
    if (notify.type === 'sk_verification') {
      await sendEmail({
        to: notify.to,
        subject: skVerificationEmailSubject(suiteKey),
        html: skVerificationEmailHtml({ suiteKey, licenseName, requesterEmail }),
        template: 'sk_verification',
        subscriptionId: id,
      })
    } else if (notify.type === 'approval_request') {
      await sendEmail({
        to: notify.to,
        subject: approvalRequestEmailSubject(suiteKey),
        html: approvalRequestEmailHtml({ suiteKey, licenseName, userEmail: requesterEmail }),
        template: 'approval_request',
        subscriptionId: id,
      })
    }
  } catch (err) {
    console.error('notification email failed:', err.message)
  }
}

function RequestModal({ license, onClose }) {
  const { profile } = useAuth()
  const [mode, setMode] = useState('suite_key') // 'suite_key' | 'ministry_id'
  const [suiteKey, setSuiteKey] = useState('')
  const [suggestedApproverEmail, setSuggestedApproverEmail] = useState('')
  const [ministryId, setMinistryId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  const fy = new Date().getFullYear()

  async function submit(e) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const result = await requestSubscription({
        licenseId: license.id,
        suiteKey: license.gtis_sponsored ? null : mode === 'suite_key' ? suiteKey : null,
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
                Suite Key
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={mode === 'ministry_id'} onChange={() => setMode('ministry_id')} />
                Ministry ID
              </label>
            </div>

            {mode === 'suite_key' ? (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Suite Key</label>
                  <input value={suiteKey} onChange={e => setSuiteKey(e.target.value)} required
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Suggested approver email <span className="text-gray-400">(only needed if this is a new Suite Key)</span>
                  </label>
                  <input type="email" value={suggestedApproverEmail} onChange={e => setSuggestedApproverEmail(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
                </div>
              </>
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Ministry ID</label>
                <input value={ministryId} onChange={e => setMinistryId(e.target.value)} required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
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

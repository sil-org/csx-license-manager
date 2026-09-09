import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AppLayout from '../components/AppLayout'
import { getLinks } from '../navLinks'
import { useAuth } from '../context/AuthContext'
import {
  getPendingSkVerifications, getPendingApprovals, getPendingProvisioning,
  confirmSkOwnership, denySkOwnership, approveSubscription, declineSubscription,
} from '../lib/approvals'
import {
  sendEmail,
  approvalRequestEmailSubject, approvalRequestEmailHtml,
  skOwnershipDeniedEmailSubject, skOwnershipDeniedEmailHtml,
  decisionApprovedEmailSubject, decisionApprovedEmailHtml,
  approvedPendingEmailSubject, approvedPendingEmailHtml,
  provisioningRequiredEmailSubject, provisioningRequiredEmailHtml,
  declinedEmailSubject, declinedEmailHtml,
} from '../lib/email'

// "What do I need to approve/decline, verify, or provision" — the actual
// provisioning UI (purchase details, activation) and cancellation (any
// status, any license you own or manage) still live on Admin -> All
// Subscriptions, which is also open to service managers (see
// allowServiceManager on the /admin/all-subscriptions route in App.jsx).
// This page just surfaces that a seat is waiting, with a link over there.
export default function ActionCenter() {
  const { profile } = useAuth()
  const [verifications, setVerifications] = useState(null)
  const [approvals, setApprovals] = useState(null)
  const [provisioning, setProvisioning] = useState(null)
  const [error, setError] = useState(null)

  function reload() {
    getPendingSkVerifications().then(setVerifications).catch(e => setError(e.message))
    getPendingApprovals().then(setApprovals).catch(e => setError(e.message))
    getPendingProvisioning().then(setProvisioning).catch(e => setError(e.message))
  }

  useEffect(reload, [])

  // confirm_sk_ownership/deny_sk_ownership return the subscriptions they just
  // advanced — mirrors GAS's confirmSkOwnershipAll/denySkOwnershipAll, which
  // sent one email per advanced request rather than per SuiteKey.
  async function handleConfirmSk(suiteKey) {
    try {
      const advanced = await confirmSkOwnership(suiteKey)
      reload()
      for (const sub of advanced || []) {
        try {
          await sendEmail({
            to: profile?.primary_email,
            subject: approvalRequestEmailSubject(suiteKey),
            html: approvalRequestEmailHtml({ suiteKey, licenseName: sub.license_name, userEmail: sub.user_email, moreInfoUrl: sub.more_info_url, price: sub.price, priceUnit: sub.price_unit }),
            template: 'approval_request',
            subscriptionId: sub.id,
          })
        } catch (err) {
          console.error('approval request email failed:', err.message)
        }
      }
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleDenySk(suiteKey) {
    if (!confirm(`Deny ownership of SuiteKey ${suiteKey}? Every pending request against it will be declined and the requesters notified.`)) return
    try {
      const declined = await denySkOwnership(suiteKey)
      reload()
      for (const sub of declined || []) {
        try {
          await sendEmail({
            to: sub.user_email,
            subject: skOwnershipDeniedEmailSubject(sub.license_name),
            html: skOwnershipDeniedEmailHtml({ suiteKey, licenseName: sub.license_name }),
            template: 'sk_ownership_denied',
            subscriptionId: sub.id,
          })
        } catch (err) {
          console.error('sk ownership denied email failed:', err.message)
        }
      }
    } catch (err) {
      setError(err.message)
    }
  }

  // approveSubscription() returns the same notify shape as requestSubscription()
  // (see buildProvisioningNotifications() in src/lib/subscriptions.js) — null unless
  // the license also needs provisioning, in which case both the requester and
  // whoever provisions the seat get emailed.
  async function handleApprove(sub) {
    try {
      const notify = await approveSubscription(sub.id)
      reload()
      for (const n of notify || []) {
        try {
          if (n.type === 'approved_pending') {
            await sendEmail({
              to: n.to,
              subject: approvedPendingEmailSubject(n.licenseName),
              html: approvedPendingEmailHtml({ sub: n.sub, licenseName: n.licenseName }),
              template: 'approved_pending',
              subscriptionId: sub.id,
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
              subscriptionId: sub.id,
            })
          } else if (n.type === 'decision_approved') {
            await sendEmail({
              to: n.to,
              subject: decisionApprovedEmailSubject(n.licenseName),
              html: decisionApprovedEmailHtml({ sub: n.sub, licenseName: n.licenseName }),
              template: 'decision_approved',
              subscriptionId: sub.id,
            })
          }
        } catch (err) {
          console.error(`${n.type} email failed:`, err.message)
        }
      }
    } catch (err) {
      setError(err.message)
    }
  }

  // decline_subscription() takes an optional free-text reason, shown in the
  // requester's email if given — mirrors GAS's declineSubscription(id, reason).
  async function handleDecline(sub) {
    const reason = window.prompt(`Decline ${sub.license_name} for ${sub.user_email}? Optionally add a reason (shown to them):`)
    if (reason === null) return
    try {
      const notify = await declineSubscription(sub.id, reason)
      reload()
      for (const n of notify || []) {
        try {
          await sendEmail({
            to: n.to,
            subject: declinedEmailSubject(n.licenseName),
            html: declinedEmailHtml({ sub: n.sub, licenseName: n.licenseName, performedBy: profile?.primary_email, reason: n.reason }),
            template: 'declined',
            subscriptionId: sub.id,
          })
        } catch (err) {
          console.error('declined email failed:', err.message)
        }
      }
    } catch (err) {
      setError(err.message)
    }
  }

  const nothingToDo = verifications?.length === 0 && approvals?.length === 0 && provisioning?.length === 0

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-3xl mx-auto p-6">
        <h1 className="font-display text-2xl font-bold text-brand mb-6">Action Center</h1>
        {error && <p className="text-sil-red mb-4">{error}</p>}

        {nothingToDo && (
          <p className="text-gray-400">Nothing needs your attention right now. This page shows SuiteKey ownership verifications, subscription approvals, and seats waiting on you to provision.</p>
        )}

        {verifications?.length > 0 && (
          <Section title="SuiteKey verification needed">
            {verifications.map(sub => (
              <Row key={sub.id} title={sub.license_name} sub={`SuiteKey ${sub.suite_key} · ${sub.user_email}`}>
                <button onClick={() => handleConfirmSk(sub.suite_key)} className="text-xs font-medium text-sil-green">Confirm ownership</button>
                <button onClick={() => handleDenySk(sub.suite_key)} className="text-xs font-medium text-sil-red">Deny</button>
              </Row>
            ))}
          </Section>
        )}

        {approvals?.length > 0 && (
          <Section title="Pending approvals">
            {approvals.map(sub => (
              <Row key={sub.id} title={sub.license_name} sub={`${sub.user_email} · ${sub.suite_key}`}>
                <button onClick={() => handleApprove(sub)} className="text-xs font-medium text-sil-green">Approve</button>
                <button onClick={() => handleDecline(sub)} className="text-xs font-medium text-sil-red">Decline</button>
              </Row>
            ))}
          </Section>
        )}

        {provisioning?.length > 0 && (
          <Section title="Needs provisioning">
            {provisioning.map(sub => (
              <Row key={sub.id} title={sub.license_name} sub={`${sub.user_email} · ${sub.suite_key}`}>
                <Link to="/admin/all-subscriptions" className="text-xs font-medium text-sil-green">Provision →</Link>
              </Row>
            ))}
          </Section>
        )}
      </div>
    </AppLayout>
  )
}

function Section({ title, children }) {
  return (
    <div className="mb-8">
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">{title}</h2>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Row({ title, sub, children }) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-4 flex items-center justify-between">
      <div>
        <p className="font-medium text-brand">{title}</p>
        <p className="text-xs text-gray-400">{sub}</p>
      </div>
      <div className="flex gap-3">{children}</div>
    </div>
  )
}

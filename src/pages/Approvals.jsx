import { useEffect, useState } from 'react'
import AppLayout from '../components/AppLayout'
import { getLinks } from '../navLinks'
import { useAuth } from '../context/AuthContext'
import {
  getPendingSkVerifications, getPendingApprovals, getProvisioningQueue,
  confirmSkOwnership, denySkOwnership, approveSubscription, declineSubscription, activateSubscription,
} from '../lib/approvals'
import {
  sendEmail,
  approvalRequestEmailSubject, approvalRequestEmailHtml,
  skOwnershipDeniedEmailSubject, skOwnershipDeniedEmailHtml,
  activationEmailSubject, activationEmailHtml,
  approvedPendingEmailSubject, approvedPendingEmailHtml,
  provisioningRequiredEmailSubject, provisioningRequiredEmailHtml,
} from '../lib/email'

export default function Approvals() {
  const { profile } = useAuth()
  const [verifications, setVerifications] = useState(null)
  const [approvals, setApprovals] = useState(null)
  const [provisioning, setProvisioning] = useState(null)
  const [error, setError] = useState(null)

  function reload() {
    getPendingSkVerifications().then(setVerifications).catch(e => setError(e.message))
    getPendingApprovals().then(setApprovals).catch(e => setError(e.message))
    getProvisioningQueue().then(setProvisioning).catch(e => setError(e.message))
  }

  useEffect(reload, [])

  async function handle(action, ...args) {
    try {
      await action(...args)
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

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
            html: approvalRequestEmailHtml({ suiteKey, licenseName: sub.license_name, userEmail: sub.user_email }),
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
  // (see src/lib/subscriptions.js's buildProvisioningNotifications) — null unless
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
              html: provisioningRequiredEmailHtml({ sub: n.sub, licenseName: n.licenseName, activationUrl: n.activationUrl }),
              template: 'provisioning_required',
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

  async function handleActivate(sub) {
    try {
      await activateSubscription(sub.id)
      reload()
      try {
        await sendEmail({
          to: sub.user_email,
          subject: activationEmailSubject(sub.license?.name),
          html: activationEmailHtml({ sub, licenseName: sub.license?.name, onboardingMessage: sub.license?.onboarding_message }),
          template: 'activation',
          subscriptionId: sub.id,
        })
      } catch (err) {
        console.error('activation email failed:', err.message)
      }
    } catch (err) {
      setError(err.message)
    }
  }

  const nothingToDo =
    verifications?.length === 0 && approvals?.length === 0 && provisioning?.length === 0

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-3xl mx-auto p-6">
        <h1 className="font-display text-2xl font-bold text-brand mb-6">Approvals</h1>
        {error && <p className="text-sil-red mb-4">{error}</p>}

        {nothingToDo && (
          <p className="text-gray-400">Nothing needs your attention right now. This page shows requests for SuiteKeys you own or licenses you service-manage.</p>
        )}

        {verifications?.length > 0 && (
          <Section title="SuiteKey verification needed">
            {verifications.map(sub => (
              <Row key={sub.id} title={sub.license?.name} sub={`SuiteKey ${sub.suite_key} · ${sub.user_email}`}>
                <button onClick={() => handleConfirmSk(sub.suite_key)} className="text-xs font-medium text-sil-green">Confirm ownership</button>
                <button onClick={() => handleDenySk(sub.suite_key)} className="text-xs font-medium text-sil-red">Deny</button>
              </Row>
            ))}
          </Section>
        )}

        {approvals?.length > 0 && (
          <Section title="Pending approvals">
            {approvals.map(sub => (
              <Row key={sub.id} title={sub.license?.name} sub={`${sub.user_email} · ${sub.suite_key}`}>
                <button onClick={() => handleApprove(sub)} className="text-xs font-medium text-sil-green">Approve</button>
                <button onClick={() => handle(declineSubscription, sub.id)} className="text-xs font-medium text-sil-red">Decline</button>
              </Row>
            ))}
          </Section>
        )}

        {provisioning?.length > 0 && (
          <Section title="Approved — needs provisioning">
            {provisioning.map(sub => (
              <Row key={sub.id} title={sub.license?.name} sub={sub.user_email}>
                <a href={sub.license?.activation_url} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand">Open vendor portal</a>
                <button onClick={() => handleActivate(sub)} className="text-xs font-medium text-sil-green">Mark active</button>
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

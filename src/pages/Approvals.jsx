import { useEffect, useState } from 'react'
import NavBar from '../components/NavBar'
import {
  getPendingSkVerifications, getPendingApprovals, getProvisioningQueue,
  confirmSkOwnership, denySkOwnership, approveSubscription, declineSubscription, activateSubscription,
} from '../lib/approvals'

export default function Approvals() {
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

  const nothingToDo =
    verifications?.length === 0 && approvals?.length === 0 && provisioning?.length === 0

  return (
    <div className="min-h-screen bg-gray-50">
      <NavBar />
      <div className="max-w-3xl mx-auto p-6">
        <h1 className="font-display text-2xl font-bold text-brand mb-6">Approvals</h1>
        {error && <p className="text-sil-red mb-4">{error}</p>}

        {nothingToDo && (
          <p className="text-gray-400">Nothing needs your attention right now. This page shows requests for Suite Keys you own or licenses you service-manage.</p>
        )}

        {verifications?.length > 0 && (
          <Section title="Suite Key verification needed">
            {verifications.map(sub => (
              <Row key={sub.id} title={sub.license?.name} sub={`Suite Key ${sub.suite_key} · ${sub.user_email}`}>
                <button onClick={() => handle(confirmSkOwnership, sub.suite_key)} className="text-xs font-medium text-sil-green">Confirm ownership</button>
                <button onClick={() => handle(denySkOwnership, sub.suite_key)} className="text-xs font-medium text-sil-red">Deny</button>
              </Row>
            ))}
          </Section>
        )}

        {approvals?.length > 0 && (
          <Section title="Pending approvals">
            {approvals.map(sub => (
              <Row key={sub.id} title={sub.license?.name} sub={`${sub.user_email} · ${sub.suite_key}`}>
                <button onClick={() => handle(approveSubscription, sub.id)} className="text-xs font-medium text-sil-green">Approve</button>
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
                <button onClick={() => handle(activateSubscription, sub.id)} className="text-xs font-medium text-sil-green">Mark active</button>
              </Row>
            ))}
          </Section>
        )}
      </div>
    </div>
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

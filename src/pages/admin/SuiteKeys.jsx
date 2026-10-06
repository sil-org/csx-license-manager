import { useEffect, useState } from 'react'
import AppLayout from '../../components/AppLayout'
import AdminTabs from '../../components/AdminTabs'
import { getLinks } from '../../navLinks'
import { getSuiteKeys, updateSuiteKeyOwner, confirmSuiteKeyOwnership, mergeSuiteKey } from '../../lib/admin'
import {
  sendEmail,
  suiteKeyAssignedEmailSubject, suiteKeyAssignedEmailHtml,
  approvalRequestEmailSubject, approvalRequestEmailHtml,
} from '../../lib/email'

const BLANK = { suite_key: '', owner_email: '', owner_group_email: '' }

const STATUS_LABEL = { unassigned: 'Unassigned', pending: 'Pending verification', confirmed: 'Confirmed' }
const STATUS_PILL = {
  unassigned: 'bg-gray-100 text-gray-400',
  pending: 'bg-sil-yellow/10 text-sil-yellow',
  confirmed: 'bg-sil-green/10 text-sil-green',
}

export default function AdminSuiteKeys() {
  const [keys, setKeys] = useState(null)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null) // suite_keys row, or BLANK for "new"
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')

  function reload() {
    getSuiteKeys().then(setKeys).catch(e => setError(e.message))
  }

  useEffect(reload, [])

  // Shared by the edit modal and the quick-confirm button below — sets the
  // owner (individual or group) and, if it actually changed, notifies the
  // new owner by email. Group ownership always goes straight to 'confirmed'
  // (no verification step) — see admin_update_suite_key_owner() for why.
  async function applyOwner({ suiteKey, ownerEmail, ownerGroupEmail, previous }) {
    const to = ownerGroupEmail || ownerEmail
    const isNewOwner = to && to !== previous
    const advanced = await updateSuiteKeyOwner({ suiteKey, newOwnerEmail: ownerEmail, ownerGroupEmail })
    if (isNewOwner) {
      try {
        await sendEmail({
          to,
          subject: suiteKeyAssignedEmailSubject(suiteKey),
          html: suiteKeyAssignedEmailHtml({ suiteKey, pendingCount: advanced?.length || 0 }),
          template: 'suite_key_assigned',
        })
      } catch (err) {
        console.error('suite key assigned email failed:', err.message)
      }
    }
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await applyOwner({
        suiteKey: editing.suite_key,
        ownerEmail: editing.is_group ? '' : editing.owner_input,
        ownerGroupEmail: editing.is_group ? editing.owner_input : '',
        previous: editing._originalOwner,
      })
      setEditing(null)
      reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  // "It'll be faster if an admin can just mark a pending ownership as
  // confirmed without editing and saving" — the real owner often confirms
  // outside the app (email, verbally) instead of completing the self-service
  // confirm flow, especially when it's an alias/group-address mismatch. This
  // skips the modal entirely and just confirms the already-known suggested
  // approver as owner directly. (Only ever an individual — group-owned keys
  // never generate a pending_sk_verification row in the first place.)
  //
  // Deliberately NOT applyOwner()/updateSuiteKeyOwner() — that RPC is for
  // "assign a new owner who still has to confirm themselves" and leaves
  // requests parked in pending_sk_verification, which is why this button used
  // to look like it did nothing. confirmSuiteKeyOwnership() actually advances
  // them, same as if the approver had confirmed via Action Center themselves.
  async function handleQuickConfirm(k) {
    setError(null)
    try {
      const advanced = await confirmSuiteKeyOwnership({ suiteKey: k.suite_key, ownerEmail: k.pendingApproverEmail })
      reload()
      for (const sub of advanced || []) {
        try {
          await sendEmail({
            to: k.pendingApproverEmail,
            subject: approvalRequestEmailSubject(k.suite_key),
            html: approvalRequestEmailHtml({ suiteKey: k.suite_key, licenseName: sub.license_name, userEmail: sub.user_email, moreInfoUrl: sub.more_info_url, price: sub.price, priceUnit: sub.price_unit }),
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

  // For data-entry typos, e.g. someone types "Relations-U_SIL~5407" instead
  // of the real "Relations-U_SIL" — repoints its subscriptions onto the
  // correct key and deletes the bad row. Server-side refuses if the "bad"
  // key actually has an owner on file (unlikely to really be a typo then).
  async function handleMerge(k) {
    const correct = window.prompt(`Merge "${k.suite_key}" into which correct SuiteKey?`)
    if (!correct) return
    setError(null)
    try {
      await mergeSuiteKey({ badKey: k.suite_key, correctKey: correct })
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

  function openEdit(k) {
    setEditing({
      ...k,
      isNew: false,
      is_group: !!k.owner_group_email,
      owner_input: k.owner_group_email || k.owner_email || '',
      _originalOwner: k.owner_group_email || k.owner_email || '',
    })
  }

  const q = search.trim().toLowerCase()
  const visibleKeys = !q ? keys : keys?.filter(k =>
    k.suite_key.toLowerCase().includes(q) ||
    (k.description || '').toLowerCase().includes(q) ||
    (k.owner_email || '').toLowerCase().includes(q) ||
    (k.owner_group_email || '').toLowerCase().includes(q)
  )

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-6xl mx-auto p-6">
        <AdminTabs />
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-display text-2xl font-bold text-brand">Admin — SuiteKeys</h1>
          <button onClick={() => setEditing({ ...BLANK, isNew: true, is_group: false, owner_input: '' })} className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2">
            + New SuiteKey
          </button>
        </div>

        {error && <p className="text-sil-red mb-4">{error}</p>}
        {!keys && !error && <p className="text-gray-400">Loading…</p>}
        {keys?.length === 0 && <p className="text-gray-400">No SuiteKeys on file yet — they're also created automatically the first time someone requests a license against a new one.</p>}

        {keys?.length > 0 && (
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by SuiteKey, owner, or description…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4"
          />
        )}
        {keys?.length > 0 && visibleKeys.length === 0 && (
          <p className="text-gray-400 mb-4">No SuiteKeys match "{search}".</p>
        )}

        {visibleKeys?.length > 0 && (
          <div className="bg-white rounded-xl shadow-xs overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-gray-400 border-b">
                <tr>
                  <th className="p-3 font-semibold uppercase text-xs tracking-wide">SuiteKey</th>
                  <th className="p-3 font-semibold uppercase text-xs tracking-wide">Ownership</th>
                  <th className="p-3 font-semibold uppercase text-xs tracking-wide">Description</th>
                  <th className="p-3 font-semibold uppercase text-xs tracking-wide">Owner</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {visibleKeys.map(k => (
                  <tr key={k.suite_key}>
                    <td
                      className={`p-3 font-medium whitespace-nowrap ${k.deprecated_at ? 'text-sil-red' : 'text-brand'}`}
                      title={k.deprecated_at ? 'This SuiteKey has been deprecated' : undefined}
                    >
                      {k.suite_key}
                    </td>
                    <td className="p-3">
                      <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_PILL[k.status]}`}>
                        {STATUS_LABEL[k.status]}
                      </span>
                    </td>
                    <td className="p-3 text-gray-500">{k.description || '—'}</td>
                    <td className="p-3 text-gray-500">
                      {k.owner_group_email ? `Group: ${k.owner_group_email}` : k.owner_email || '—'}
                    </td>
                    <td className="p-3">
                      <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                        {k.status === 'pending' && k.pendingApproverEmail && (
                          <button
                            onClick={() => handleQuickConfirm(k)}
                            className="text-xs font-medium text-sil-green"
                            title={`Confirm ${k.pendingApproverEmail} as owner without opening the edit form`}
                          >
                            Confirm as {k.pendingApproverEmail}
                          </button>
                        )}
                        {!k.owner_email && !k.owner_group_email && (
                          <button
                            onClick={() => handleMerge(k)}
                            className="text-xs font-medium text-gray-400"
                            title="Fix a typo — repoint this key's requests onto the correct SuiteKey and remove this one"
                          >
                            Merge into…
                          </button>
                        )}
                        <button onClick={() => openEdit(k)} className="text-xs font-medium text-brand">Edit</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/40 overflow-y-auto">
          {/* min-h-full so a tall modal scrolls from its true top instead of
              being clipped by flex centering against a fixed-height container. */}
          <div className="min-h-full flex items-center justify-center p-4">
            <form onSubmit={handleSave} className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full space-y-3 my-8">
              <h2 className="font-display text-xl font-bold text-brand mb-2">
                {editing.isNew ? 'New SuiteKey' : 'Edit SuiteKey'}
              </h2>
  
              <label className="block text-sm text-gray-700">
                SuiteKey
                <input
                  value={editing.suite_key}
                  onChange={e => setEditing({ ...editing, suite_key: e.target.value })}
                  disabled={!editing.isNew}
                  required
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-500"
                />
              </label>
  
              <label className="block text-sm text-gray-700">
                Owner email
                <input
                  type="email"
                  value={editing.owner_input || ''}
                  onChange={e => setEditing({ ...editing, owner_input: e.target.value })}
                  placeholder="Leave blank to unassign"
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
              </label>
  
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={!!editing.is_group}
                  onChange={e => setEditing({ ...editing, is_group: e.target.checked })}
                />
                This is a Google Group, not one person
              </label>
              <span className="block text-xs text-gray-400 -mt-2">
                {editing.is_group
                  ? "Anyone currently in this group can approve/decline/revoke charges to this key — no per-request verification step, since group membership is already the authorization check. Membership is synced from Google on a schedule, not read live."
                  : "Takes effect immediately — no confirmation needed from them. Any requests still awaiting verification on this key move into their Action Center queue and they're notified by email."}
              </span>
  
              {!editing.isNew && (
                <div className="block text-sm text-gray-700">
                  Description
                  <p className="mt-1 text-gray-500">{editing.description || '—'}</p>
                  <span className="block text-xs text-gray-400">
                    Set from the finance system's daily sync, not editable here.
                  </span>
                </div>
              )}
  
              {error && <p className="text-sil-red text-sm">{error}</p>}
  
              <div className="flex gap-3 pt-3">
                <button type="submit" disabled={saving} className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2">
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button type="button" onClick={() => setEditing(null)} className="text-sm font-medium text-gray-500">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </AppLayout>
  )
}

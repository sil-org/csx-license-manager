import { useEffect, useState } from 'react'
import AppLayout from '../../components/AppLayout'
import { getLinks } from '../../navLinks'
import { getSuiteKeys, updateSuiteKeyOwner } from '../../lib/admin'
import { sendEmail, suiteKeyAssignedEmailSubject, suiteKeyAssignedEmailHtml } from '../../lib/email'

const BLANK = { suite_key: '', owner_email: '', owner_group_email: '', description: '' }

const STATUS_LABEL = { unassigned: 'Unassigned', pending: 'Pending verification', confirmed: 'Confirmed' }
const STATUS_COLOR = { unassigned: 'text-gray-400', pending: 'text-sil-yellow', confirmed: 'text-sil-green' }

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
  async function applyOwner({ suiteKey, ownerEmail, ownerGroupEmail, description, previous }) {
    const to = ownerGroupEmail || ownerEmail
    const isNewOwner = to && to !== previous
    const advanced = await updateSuiteKeyOwner({ suiteKey, newOwnerEmail: ownerEmail, ownerGroupEmail, description })
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
      const isGroup = editing.ownership_mode === 'group'
      await applyOwner({
        suiteKey: editing.suite_key,
        ownerEmail: isGroup ? '' : editing.owner_email,
        ownerGroupEmail: isGroup ? editing.owner_group_email : '',
        description: editing.description,
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
  async function handleQuickConfirm(k) {
    setError(null)
    try {
      await applyOwner({
        suiteKey: k.suite_key,
        ownerEmail: k.pendingApproverEmail,
        ownerGroupEmail: '',
        description: k.description,
        previous: k.owner_email,
      })
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

  function openEdit(k) {
    setEditing({
      ...k,
      isNew: false,
      ownership_mode: k.owner_group_email ? 'group' : 'individual',
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
      <div className="max-w-3xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-display text-2xl font-bold text-brand">Admin — SuiteKeys</h1>
          <button onClick={() => setEditing({ ...BLANK, isNew: true, ownership_mode: 'individual' })} className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2">
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
            placeholder="Search by SuiteKey, description, or owner…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4"
          />
        )}
        {keys?.length > 0 && visibleKeys.length === 0 && (
          <p className="text-gray-400 mb-4">No SuiteKeys match "{search}".</p>
        )}

        <div className="bg-white rounded-xl shadow-sm divide-y">
          {visibleKeys?.map(k => (
            <div key={k.suite_key} className="p-4 flex items-center justify-between">
              <div>
                <p className="font-medium text-brand">{k.suite_key}</p>
                <p className="text-xs text-gray-400">{k.description || 'No description'}</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {k.owner_group_email ? `Group: ${k.owner_group_email}` : k.owner_email || 'No owner assigned'}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs font-medium ${STATUS_COLOR[k.status]}`}>{STATUS_LABEL[k.status]}</span>
                {k.status === 'pending' && k.pendingApproverEmail && (
                  <button
                    onClick={() => handleQuickConfirm(k)}
                    className="text-xs font-medium text-sil-green"
                    title={`Confirm ${k.pendingApproverEmail} as owner without opening the edit form`}
                  >
                    Confirm as {k.pendingApproverEmail}
                  </button>
                )}
                <button onClick={() => openEdit(k)} className="text-xs font-medium text-brand">Edit</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4">
          <form onSubmit={handleSave} className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full space-y-3">
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

            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" checked={editing.ownership_mode === 'individual'} onChange={() => setEditing({ ...editing, ownership_mode: 'individual' })} />
                Individual owner
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={editing.ownership_mode === 'group'} onChange={() => setEditing({ ...editing, ownership_mode: 'group' })} />
                Google Group
              </label>
            </div>

            {editing.ownership_mode === 'individual' ? (
              <label className="block text-sm text-gray-700">
                Owner email
                <input
                  type="email"
                  value={editing.owner_email || ''}
                  onChange={e => setEditing({ ...editing, owner_email: e.target.value })}
                  placeholder="Leave blank to unassign"
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
                <span className="block text-xs text-gray-400 mt-0.5">
                  Takes effect immediately — no confirmation needed from them. Any requests still awaiting
                  verification on this key move into their Approvals queue and they're notified by email.
                </span>
              </label>
            ) : (
              <label className="block text-sm text-gray-700">
                Google Group email
                <input
                  type="email"
                  value={editing.owner_group_email || ''}
                  onChange={e => setEditing({ ...editing, owner_group_email: e.target.value })}
                  placeholder="e.g. it-team@sil.org"
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
                <span className="block text-xs text-gray-400 mt-0.5">
                  Anyone currently in this group can approve/decline/revoke charges to this key — no per-request
                  verification step, since group membership is already the authorization check. Membership is
                  synced from Google on a schedule, not read live.
                </span>
              </label>
            )}

            <label className="block text-sm text-gray-700">
              Description
              <input
                value={editing.description || ''}
                onChange={e => setEditing({ ...editing, description: e.target.value })}
                className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </label>

            {error && <p className="text-sil-red text-sm">{error}</p>}

            <div className="flex gap-3 pt-3">
              <button type="submit" disabled={saving} className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2">
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" onClick={() => setEditing(null)} className="text-sm font-medium text-gray-500">Cancel</button>
            </div>
          </form>
        </div>
      )}
    </AppLayout>
  )
}

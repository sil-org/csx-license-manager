import { useEffect, useState } from 'react'
import AppLayout from '../../components/AppLayout'
import { getLinks } from '../../navLinks'
import { getSuiteKeys, updateSuiteKeyOwner } from '../../lib/admin'
import { sendEmail, suiteKeyAssignedEmailSubject, suiteKeyAssignedEmailHtml } from '../../lib/email'

const BLANK = { suite_key: '', owner_email: '', description: '' }

const STATUS_LABEL = { unassigned: 'Unassigned', pending: 'Pending verification', confirmed: 'Confirmed' }
const STATUS_COLOR = { unassigned: 'text-gray-400', pending: 'text-sil-yellow', confirmed: 'text-sil-green' }

export default function AdminSuiteKeys() {
  const [keys, setKeys] = useState(null)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null) // suite_keys row, or BLANK for "new"
  const [saving, setSaving] = useState(false)

  function reload() {
    getSuiteKeys().then(setKeys).catch(e => setError(e.message))
  }

  useEffect(reload, [])

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const isNewOwner = editing.owner_email && editing.owner_email !== editing._originalOwnerEmail
      const advanced = await updateSuiteKeyOwner({
        suiteKey: editing.suite_key,
        newOwnerEmail: editing.owner_email,
        description: editing.description,
      })
      if (isNewOwner) {
        try {
          await sendEmail({
            to: editing.owner_email,
            subject: suiteKeyAssignedEmailSubject(editing.suite_key),
            html: suiteKeyAssignedEmailHtml({ suiteKey: editing.suite_key, pendingCount: advanced?.length || 0 }),
            template: 'suite_key_assigned',
          })
        } catch (err) {
          console.error('suite key assigned email failed:', err.message)
        }
      }
      setEditing(null)
      reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-3xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-display text-2xl font-bold text-brand">Admin — Suite Keys</h1>
          <button onClick={() => setEditing({ ...BLANK, isNew: true })} className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2">
            + New Suite Key
          </button>
        </div>

        {error && <p className="text-sil-red mb-4">{error}</p>}
        {!keys && !error && <p className="text-gray-400">Loading…</p>}
        {keys?.length === 0 && <p className="text-gray-400">No Suite Keys on file yet — they're also created automatically the first time someone requests a license against a new one.</p>}

        <div className="bg-white rounded-xl shadow-sm divide-y">
          {keys?.map(k => (
            <div key={k.suite_key} className="p-4 flex items-center justify-between">
              <div>
                <p className="font-medium text-brand">{k.suite_key}</p>
                <p className="text-xs text-gray-400">{k.description || 'No description'}</p>
                <p className="text-xs text-gray-500 mt-0.5">{k.owner_email || 'No owner assigned'}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs font-medium ${STATUS_COLOR[k.status]}`}>{STATUS_LABEL[k.status]}</span>
                <button
                  onClick={() => setEditing({ ...k, isNew: false, _originalOwnerEmail: k.owner_email || '' })}
                  className="text-xs font-medium text-brand"
                >
                  Edit
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4">
          <form onSubmit={handleSave} className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full space-y-3">
            <h2 className="font-display text-xl font-bold text-brand mb-2">
              {editing.isNew ? 'New Suite Key' : 'Edit Suite Key'}
            </h2>

            <label className="block text-sm text-gray-700">
              Suite Key
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

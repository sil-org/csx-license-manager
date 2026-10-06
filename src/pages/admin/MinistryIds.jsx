import { useEffect, useState } from 'react'
import AppLayout from '../../components/AppLayout'
import AdminTabs from '../../components/AdminTabs'
import { getLinks } from '../../navLinks'
import { getMinistryIds, updateMinistryId } from '../../lib/admin'

const BLANK = { email: '', ministry_id: '' }

export default function AdminMinistryIds() {
  const [ids, setIds] = useState(null)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null) // ministry_ids row, or BLANK for "new"
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')

  function reload() {
    getMinistryIds().then(setIds).catch(e => setError(e.message))
  }

  useEffect(reload, [])

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await updateMinistryId({ email: editing.email, ministryId: editing.ministry_id })
      setEditing(null)
      reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleRemove(email) {
    if (!confirm(`Remove the Ministry ID for ${email}?`)) return
    try {
      await updateMinistryId({ email, ministryId: '' })
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

  const q = search.trim().toLowerCase()
  const visibleIds = !q ? ids : ids?.filter(m =>
    m.email.toLowerCase().includes(q) || m.ministry_id.includes(q)
  )

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-6xl mx-auto p-6">
        <AdminTabs />
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-display text-2xl font-bold text-brand">Admin — Ministry IDs</h1>
          <button onClick={() => setEditing({ ...BLANK, isNew: true })} className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2">
            + New Ministry ID
          </button>
        </div>

        {error && <p className="text-sil-red mb-4">{error}</p>}
        {!ids && !error && <p className="text-gray-400">Loading…</p>}
        {ids?.length === 0 && <p className="text-gray-400">No Ministry IDs on file yet.</p>}

        {ids?.length > 0 && (
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by email or Ministry ID…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4"
          />
        )}
        {ids?.length > 0 && visibleIds.length === 0 && (
          <p className="text-gray-400 mb-4">No Ministry IDs match "{search}".</p>
        )}

        {visibleIds?.length > 0 && (
          <div className="bg-white rounded-xl shadow-xs overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-gray-400 border-b">
                <tr>
                  <th className="p-3 font-semibold uppercase text-xs tracking-wide">Email</th>
                  <th className="p-3 font-semibold uppercase text-xs tracking-wide">Ministry ID</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {visibleIds.map(m => (
                  <tr key={m.email}>
                    <td className="p-3 font-medium text-brand">{m.email}</td>
                    <td className="p-3 text-gray-500">{m.ministry_id}</td>
                    <td className="p-3">
                      <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                        <button
                          onClick={() => setEditing({ ...m, isNew: false, _originalEmail: m.email })}
                          className="text-xs font-medium text-brand"
                        >
                          Edit
                        </button>
                        <button onClick={() => handleRemove(m.email)} className="text-xs font-medium text-sil-red">Remove</button>
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
            <form onSubmit={handleSave} className="bg-white rounded-2xl shadow-lg p-8 max-w-sm w-full space-y-3 my-8">
              <h2 className="font-display text-xl font-bold text-brand mb-2">
                {editing.isNew ? 'New Ministry ID' : 'Edit Ministry ID'}
              </h2>
  
              <label className="block text-sm text-gray-700">
                Email
                <input
                  type="email"
                  value={editing.email}
                  onChange={e => setEditing({ ...editing, email: e.target.value })}
                  disabled={!editing.isNew}
                  required
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-500"
                />
              </label>
  
              <label className="block text-sm text-gray-700">
                Ministry ID
                <input
                  value={editing.ministry_id}
                  onChange={e => setEditing({ ...editing, ministry_id: e.target.value })}
                  inputMode="numeric"
                  placeholder="6 digits"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                />
                <span className="block text-xs text-gray-400 mt-0.5">Exactly 6 digits.</span>
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
        </div>
      )}
    </AppLayout>
  )
}

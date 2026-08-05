import { useEffect, useState } from 'react'
import AppLayout from '../../components/AppLayout'
import AdminTabs from '../../components/AdminTabs'
import { getLinks } from '../../navLinks'
import { getProfiles, setProfileRole } from '../../lib/admin'
import { useAuth } from '../../context/AuthContext'

// Promote/demote admins — previously only possible via raw SQL (see the old
// README instructions). admin_set_role() refuses to demote the last
// remaining admin, so this can't lock everyone out of Admin entirely.
export default function AdminUsers() {
  const { profile } = useAuth()
  const [profiles, setProfiles] = useState(null)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')

  function reload() {
    getProfiles().then(setProfiles).catch(e => setError(e.message))
  }
  useEffect(reload, [])

  async function handleToggle(p) {
    const nextRole = p.role === 'admin' ? 'member' : 'admin'
    if (!confirm(`${nextRole === 'admin' ? 'Promote' : 'Demote'} ${p.primary_email} ${nextRole === 'admin' ? 'to admin' : 'to member'}?`)) return
    setError(null)
    try {
      await setProfileRole({ profileId: p.id, role: nextRole })
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

  // Default view is admins only — this page is for managing who has admin
  // access, not a staff directory. Searching looks across everyone, though,
  // so a non-admin can still be found and promoted.
  const q = search.trim().toLowerCase()
  const visibleProfiles = !q
    ? profiles?.filter(p => p.role === 'admin')
    : profiles?.filter(p => p.primary_email.toLowerCase().includes(q) || (p.display_name || '').toLowerCase().includes(q))

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-6xl mx-auto p-6">
        <AdminTabs />
        <h1 className="font-display text-2xl font-bold text-brand mb-6">Admin — Users</h1>

        <div className="bg-brand/[0.06] border border-brand/20 rounded-xl p-4 mb-6 text-sm text-gray-700">
          New to maintaining this project? Start with the{' '}
          <a
            href="https://github.com/kode-monki/license-manager/blob/main/README.md"
            target="_blank" rel="noreferrer"
            className="text-brand font-medium hover:underline"
          >
            README
          </a>{' '}
          — it covers the architecture, where the business logic lives, and what's not ported from the
          original Google Apps Script app yet.
        </div>

        {error && <p className="text-sil-red mb-4">{error}</p>}
        {!profiles && !error && <p className="text-gray-400">Loading…</p>}

        {profiles?.length > 0 && (
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Showing admins only — search anyone by name or email to promote them…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4"
          />
        )}

        <div className="bg-white rounded-xl shadow-sm divide-y">
          {visibleProfiles?.map(p => (
            <div key={p.id} className="p-4 flex items-center justify-between">
              <div>
                <p className="font-medium text-brand">{p.display_name}</p>
                <p className="text-xs text-gray-400">{p.primary_email}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-xs font-medium ${p.role === 'admin' ? 'text-sil-green' : 'text-gray-400'}`}>
                  {p.role === 'admin' ? 'Admin' : 'Member'}
                </span>
                <button
                  onClick={() => handleToggle(p)}
                  disabled={p.id === profile?.id && p.role === 'admin'}
                  title={p.id === profile?.id && p.role === 'admin' ? "Can't demote yourself from here" : undefined}
                  className="text-xs font-medium text-brand disabled:text-gray-300"
                >
                  {p.role === 'admin' ? 'Demote' : 'Promote'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppLayout>
  )
}

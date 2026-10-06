import { useEffect, useState } from 'react'
import AppLayout from '../../components/AppLayout'
import AdminTabs from '../../components/AdminTabs'
import { getLinks } from '../../navLinks'
import { getAnnouncement, saveAnnouncement } from '../../lib/announcements'

export default function AdminAnnouncements() {
  const [form, setForm] = useState(null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  function reload() {
    getAnnouncement()
      .then(a => setForm({
        message: a?.message || '',
        cta_label: a?.cta_label || '',
        cta_url: a?.cta_url || '',
        enabled: a?.enabled || false,
        updated_at: a?.updated_at || null,
        updated_by: a?.updated_by || null,
      }))
      .catch(e => setError(e.message))
  }

  useEffect(reload, [])

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      await saveAnnouncement({
        message: form.message,
        ctaLabel: form.cta_label,
        ctaUrl: form.cta_url,
        enabled: form.enabled,
      })
      reload()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-6xl mx-auto p-6">
        <AdminTabs />
        <h1 className="font-display text-2xl font-bold text-brand mb-6">Admin — Announcement</h1>

        {!form && !error && <p className="text-gray-400">Loading…</p>}

        {form && (
          <form onSubmit={handleSave} className="bg-white rounded-xl shadow-xs p-6 max-w-xl space-y-4">
            <label className="block text-sm text-gray-700">
              Message
              <textarea
                value={form.message}
                onChange={e => setForm({ ...form, message: e.target.value })}
                rows={3}
                className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </label>

            <label className="block text-sm text-gray-700">
              Call-to-action label
              <input
                value={form.cta_label}
                onChange={e => setForm({ ...form, cta_label: e.target.value })}
                placeholder="Learn more"
                className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </label>

            <label className="block text-sm text-gray-700">
              Call-to-action URL
              <input
                type="url"
                value={form.cta_url}
                onChange={e => setForm({ ...form, cta_url: e.target.value })}
                placeholder="https://…"
                className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              />
            </label>

            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={e => setForm({ ...form, enabled: e.target.checked })}
              />
              Show banner to all users
            </label>

            {error && <p className="text-sil-red text-sm">{error}</p>}

            <button type="submit" disabled={saving} className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2">
              {saving ? 'Saving…' : 'Save'}
            </button>

            {form.updated_by && (
              <p className="text-xs text-gray-400 pt-2">
                Last updated by {form.updated_by} on {new Date(form.updated_at).toLocaleString()}
              </p>
            )}
          </form>
        )}
      </div>
    </AppLayout>
  )
}

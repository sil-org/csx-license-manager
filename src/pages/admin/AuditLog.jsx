import { useEffect, useState } from 'react'
import AppLayout from '../../components/AppLayout'
import AdminTabs from '../../components/AdminTabs'
import { getLinks } from '../../navLinks'
import { getAuditLog, getAuditLogForExport } from '../../lib/admin'
import { getAllLicenses } from '../../lib/licenses'

const PAGE_SIZE = 50

const ACTIONS = [
  'requested', 'auto_approved', 'approved', 'declined', 'activated', 'revoked',
  'cancelled', 'sk_verified', 'imported', 'sk_merged', 'suite_key_updated',
]

const EMPTY_FILTERS = { userEmail: '', licenseName: '', action: '', suiteKey: '', dateFrom: '', dateTo: '' }

function actionLabel(action) {
  return action.replace(/_/g, ' ')
}

function csvEscape(value) {
  const s = String(value ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCsv(rows, filename) {
  const header = ['When', 'Action', 'License', 'User', 'SuiteKey', 'By', 'Notes']
  const lines = [header, ...rows.map(r => [
    new Date(r.created_at).toLocaleString(), r.action, r.license_name, r.user_email, r.suite_key, r.performed_by, r.notes,
  ])]
  const csv = lines.map(line => line.map(csvEscape).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function AdminAuditLog() {
  const [draft, setDraft] = useState(EMPTY_FILTERS)
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState(null)
  const [count, setCount] = useState(0)
  const [licenses, setLicenses] = useState([])
  const [error, setError] = useState(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    getAllLicenses().then(setLicenses).catch(() => {})
  }, [])

  useEffect(() => {
    setError(null)
    getAuditLog({ ...filters, page, pageSize: PAGE_SIZE })
      .then(({ rows, count }) => { setRows(rows); setCount(count) })
      .catch(e => setError(e.message))
  }, [filters, page])

  function applyFilters(e) {
    e.preventDefault()
    setPage(0)
    setFilters(draft)
  }

  function clearFilters() {
    setDraft(EMPTY_FILTERS)
    setFilters(EMPTY_FILTERS)
    setPage(0)
  }

  async function handleExport() {
    setExporting(true)
    setError(null)
    try {
      const data = await getAuditLogForExport(filters)
      downloadCsv(data, `audit-log-${new Date().toISOString().split('T')[0]}.csv`)
    } catch (err) {
      setError(err.message)
    } finally {
      setExporting(false)
    }
  }

  const from = count === 0 ? 0 : page * PAGE_SIZE + 1
  const to = Math.min(count, page * PAGE_SIZE + PAGE_SIZE)
  const hasFilters = Object.values(filters).some(Boolean)

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-6xl mx-auto p-6">
        <AdminTabs />
        <h1 className="font-display text-2xl font-bold text-brand mb-6">Admin — Audit Log</h1>
        {error && <p className="text-sil-red mb-4">{error}</p>}

        <form onSubmit={applyFilters} className="bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-wrap items-end gap-3">
          <label className="text-sm text-gray-700">
            User
            <input
              value={draft.userEmail}
              onChange={e => setDraft(d => ({ ...d, userEmail: e.target.value }))}
              placeholder="email…"
              className="block mt-1 border border-gray-300 rounded-lg px-3 py-2 text-sm w-44"
            />
          </label>
          <label className="text-sm text-gray-700">
            License
            <select
              value={draft.licenseName}
              onChange={e => setDraft(d => ({ ...d, licenseName: e.target.value }))}
              className="block mt-1 border border-gray-300 rounded-lg px-3 py-2 text-sm w-44"
            >
              <option value="">All licenses</option>
              {licenses.map(l => <option key={l.id} value={l.name}>{l.name}</option>)}
            </select>
          </label>
          <label className="text-sm text-gray-700">
            Action
            <select
              value={draft.action}
              onChange={e => setDraft(d => ({ ...d, action: e.target.value }))}
              className="block mt-1 border border-gray-300 rounded-lg px-3 py-2 text-sm w-40"
            >
              <option value="">All actions</option>
              {ACTIONS.map(a => <option key={a} value={a}>{actionLabel(a)}</option>)}
            </select>
          </label>
          <label className="text-sm text-gray-700">
            SuiteKey
            <input
              value={draft.suiteKey}
              onChange={e => setDraft(d => ({ ...d, suiteKey: e.target.value }))}
              placeholder="suite key…"
              className="block mt-1 border border-gray-300 rounded-lg px-3 py-2 text-sm w-36"
            />
          </label>
          <label className="text-sm text-gray-700">
            From
            <input
              type="date"
              value={draft.dateFrom}
              onChange={e => setDraft(d => ({ ...d, dateFrom: e.target.value }))}
              className="block mt-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm text-gray-700">
            To
            <input
              type="date"
              value={draft.dateTo}
              onChange={e => setDraft(d => ({ ...d, dateTo: e.target.value }))}
              className="block mt-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <button type="submit" className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2 hover:bg-brand-dark transition">
            Search
          </button>
          {hasFilters && (
            <button type="button" onClick={clearFilters} className="text-sm font-medium text-gray-500 px-2 py-2">
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting || count === 0}
            className="text-sm font-medium text-brand border border-brand rounded-lg px-4 py-2 ml-auto disabled:opacity-50"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </form>

        {rows?.length === 0 && (
          <p className="text-gray-400 mb-4">No entries match these filters.</p>
        )}

        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-gray-400 border-b">
              <tr>
                <th className="p-3">When</th>
                <th className="p-3">Action</th>
                <th className="p-3">License</th>
                <th className="p-3">User</th>
                <th className="p-3">SuiteKey</th>
                <th className="p-3">By</th>
                <th className="p-3">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows?.map(entry => (
                <tr key={entry.id}>
                  <td className="p-3 text-gray-500 whitespace-nowrap">{new Date(entry.created_at).toLocaleString()}</td>
                  <td className="p-3 font-medium text-brand">{entry.action}</td>
                  <td className="p-3">{entry.license_name}</td>
                  <td className="p-3">{entry.user_email}</td>
                  <td className="p-3">{entry.suite_key}</td>
                  <td className="p-3">{entry.performed_by}</td>
                  <td className="p-3 text-gray-500">{entry.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {count > 0 && (
          <div className="flex items-center justify-between mt-4 text-sm text-gray-500">
            <span>Showing {from}–{to} of {count}</span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-40"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(p => p + 1)}
                disabled={to >= count}
                className="px-3 py-1.5 border border-gray-300 rounded-lg disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  )
}

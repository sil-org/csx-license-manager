import { useState } from 'react'
import AppLayout from '../../components/AppLayout'
import AdminTabs from '../../components/AdminTabs'
import { getLinks } from '../../navLinks'
import { getFinanceExport } from '../../lib/admin'

function todayStr() {
  return new Date().toISOString().split('T')[0]
}
function firstOfMonthStr() {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0]
}

function csvEscape(value) {
  const s = String(value ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function downloadCsv(rows, filename) {
  const header = ['User', 'License', 'Billed to', 'Cost', 'Price paid', 'Product key', 'Invoice #', 'Started', 'Renewed', 'Status', 'Notes']
  const lines = [header, ...rows.map(r => [
    r.user_email, r.license_name, r.billing_label, r.cost, r.price_paid, r.product_key, r.invoice_number,
    r.start_date, r.renewed_date, r.status, r.notes,
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

// Mirrors GAS's Admin Panel "Finance Export" tab. Pro-rated cost math lives
// in calc_prorated_cost() (supabase/schema_licenses.sql) — see its comment
// for the monthly-vs-annual formulas ported from Catalog.gs.
export default function AdminFinanceExport() {
  const [from, setFrom] = useState(firstOfMonthStr())
  const [to, setTo] = useState(todayStr())
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  async function handlePreview() {
    setLoading(true)
    setError(null)
    try {
      setRows(await getFinanceExport({ from, to }))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  async function handleExport() {
    setError(null)
    try {
      const data = await getFinanceExport({ from, to })
      downloadCsv(data, `finance-export-${from}-to-${to}.csv`)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-6xl mx-auto p-6">
        <AdminTabs />
        <h1 className="font-display text-2xl font-bold text-brand mb-2">Finance Export</h1>
        <p className="text-sm text-gray-500 mb-6">
          Exports all active subscriptions, plus approved (not-yet-activated) subscriptions started
          in the selected date range. Licenses marked "Pro-rated" calculate cost based on months
          (or days, for monthly billing) remaining until renewal.
        </p>

        <div className="flex items-end gap-3 mb-6">
          <label className="text-sm text-gray-700">
            From
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
              className="block mt-1 border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </label>
          <label className="text-sm text-gray-700">
            To
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
              className="block mt-1 border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </label>
          <button onClick={handleExport} className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2 hover:bg-brand-dark transition">
            Export CSV
          </button>
          <button onClick={handlePreview} disabled={loading} className="text-sm font-medium text-brand border border-brand rounded-lg px-4 py-2">
            {loading ? 'Loading…' : 'Preview'}
          </button>
        </div>

        {error && <p className="text-sil-red mb-4">{error}</p>}

        {rows && (
          rows.length === 0 ? (
            <p className="text-gray-400">No active subscriptions, or approved subscriptions started in that range.</p>
          ) : (
            <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-gray-400 border-b">
                  <tr>
                    <th className="p-3">User</th>
                    <th className="p-3">License</th>
                    <th className="p-3">Billed to</th>
                    <th className="p-3">Cost</th>
                    <th className="p-3">Price paid</th>
                    <th className="p-3">Product key</th>
                    <th className="p-3">Invoice #</th>
                    <th className="p-3">Started</th>
                    <th className="p-3">Renewed</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r, i) => (
                    <tr key={i} className="hover:bg-gray-50 transition-colors">
                      <td className="p-3">{r.user_email}</td>
                      <td className="p-3 font-medium text-brand">{r.license_name}</td>
                      <td className="p-3 text-gray-500">{r.billing_label}</td>
                      <td className="p-3 text-gray-700">${Number(r.cost).toFixed(2)}</td>
                      <td className="p-3 text-gray-700">{r.price_paid != null ? `$${Number(r.price_paid).toFixed(2)}` : '—'}</td>
                      <td className="p-3 text-gray-500">{r.product_key || '—'}</td>
                      <td className="p-3 text-gray-500">{r.invoice_number || '—'}</td>
                      <td className="p-3 text-gray-500 whitespace-nowrap">{r.start_date}</td>
                      <td className="p-3 text-gray-500 whitespace-nowrap">{r.renewed_date || '—'}</td>
                      <td className="p-3 text-gray-500">{r.status}</td>
                      <td className="p-3 text-gray-500">{r.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </AppLayout>
  )
}

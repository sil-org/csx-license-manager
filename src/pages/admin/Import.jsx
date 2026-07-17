import { useState } from 'react'
import AppLayout from '../../components/AppLayout'
import AdminTabs from '../../components/AdminTabs'
import { getLinks } from '../../navLinks'
import { importSubscriptions } from '../../lib/admin'

const EXPECTED_COLUMNS = ['user_email', 'license_name', 'suite_key', 'start_date', 'fy']

// Minimal CSV parser — handles quoted fields (commas/newlines/escaped quotes
// inside quotes), which a naive split(',') would break on.
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f !== '')) rows.push(row)
      row = []
    } else {
      field += c
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

// Bulk-imports already-active subscriptions from a legacy/historical CSV —
// mirrors GAS's Admin Panel "Import" tab. Expected header row (order doesn't
// matter, extra columns are ignored): user_email, license_name, suite_key,
// start_date (optional), fy (optional). suite_key accepts a real SuiteKey, a
// 6-digit Ministry ID, or blank for a GTIS-sponsored license.
export default function AdminImport() {
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState(null) // parsed rows, before import
  const [results, setResults] = useState(null) // {ok, error?, row}[] after import
  const [error, setError] = useState(null)
  const [importing, setImporting] = useState(false)

  function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    setResults(null)
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = parseCsv(String(reader.result))
        if (parsed.length < 2) throw new Error('CSV has no data rows')
        const header = parsed[0].map(h => h.trim().toLowerCase())
        const missing = ['user_email', 'license_name', 'suite_key'].filter(c => !header.includes(c))
        if (missing.length) throw new Error(`Missing required column(s): ${missing.join(', ')}`)
        const parsedRows = parsed.slice(1).map(cols => {
          const obj = {}
          header.forEach((h, i) => { if (EXPECTED_COLUMNS.includes(h)) obj[h] = (cols[i] || '').trim() })
          return obj
        })
        setRows(parsedRows)
      } catch (err) {
        setError(err.message)
        setRows(null)
      }
    }
    reader.readAsText(file)
  }

  async function handleImport() {
    setImporting(true)
    setError(null)
    try {
      setResults(await importSubscriptions(rows))
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  const successCount = results?.filter(r => r.ok).length ?? 0
  const failCount = results ? results.length - successCount : 0

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-6xl mx-auto p-6">
        <AdminTabs />
        <h1 className="font-display text-2xl font-bold text-brand mb-2">Import</h1>
        <p className="text-sm text-gray-500 mb-1">
          Bulk-imports already-active subscriptions from a legacy/historical source — no approval
          emails, no verification step. One row per subscription.
        </p>
        <p className="text-xs text-gray-400 mb-6">
          Required columns: <code className="bg-gray-100 px-1 rounded">user_email</code>,{' '}
          <code className="bg-gray-100 px-1 rounded">license_name</code>,{' '}
          <code className="bg-gray-100 px-1 rounded">suite_key</code> (a real SuiteKey, a 6-digit Ministry
          ID, or blank for GTIS-sponsored licenses). Optional: <code className="bg-gray-100 px-1 rounded">start_date</code>,{' '}
          <code className="bg-gray-100 px-1 rounded">fy</code>.
        </p>

        <input type="file" accept=".csv" onChange={handleFile} className="text-sm mb-4" />

        {error && <p className="text-sil-red mb-4">{error}</p>}

        {rows && !results && (
          <>
            <p className="text-sm text-gray-700 mb-3">
              {fileName}: {rows.length} row{rows.length === 1 ? '' : 's'} parsed. Review, then import.
            </p>
            <div className="bg-white rounded-xl shadow-sm overflow-x-auto mb-4">
              <table className="w-full text-sm">
                <thead className="text-left text-gray-400 border-b">
                  <tr>{EXPECTED_COLUMNS.map(c => <th key={c} className="p-3">{c}</th>)}</tr>
                </thead>
                <tbody className="divide-y">
                  {rows.slice(0, 20).map((r, i) => (
                    <tr key={i}>{EXPECTED_COLUMNS.map(c => <td key={c} className="p-3">{r[c] || ''}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 20 && <p className="text-xs text-gray-400 p-3">…and {rows.length - 20} more</p>}
            </div>
            <button onClick={handleImport} disabled={importing} className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2 hover:bg-brand-dark transition">
              {importing ? 'Importing…' : `Import ${rows.length} row${rows.length === 1 ? '' : 's'}`}
            </button>
          </>
        )}

        {results && (
          <>
            <p className="text-sm mb-3">
              <span className="text-sil-green font-medium">{successCount} imported</span>
              {failCount > 0 && <span className="text-sil-red font-medium">, {failCount} failed</span>}
            </p>
            <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-gray-400 border-b">
                  <tr>
                    <th className="p-3">Row</th>
                    <th className="p-3">Result</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {results.map((r, i) => (
                    <tr key={i}>
                      <td className="p-3 text-gray-500">{r.row.user_email} · {r.row.license_name}</td>
                      <td className={`p-3 ${r.ok ? 'text-sil-green' : 'text-sil-red'}`}>{r.ok ? 'Imported' : r.error}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </AppLayout>
  )
}

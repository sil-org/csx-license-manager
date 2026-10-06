import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import AppLayout from '../../components/AppLayout'
import AdminTabs from '../../components/AdminTabs'
import { getLinks } from '../../navLinks'
import { importSubscriptions, importLicenses, importSubscriptionsFull, importAuditLog, importTeamHierarchy, importScoCodes } from '../../lib/admin'

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

const EXPECTED_COLUMNS = ['user_email', 'license_name', 'suite_key', 'start_date', 'fy', 'requester_email']
const TEAM_HIERARCHY_COLUMNS = ['primary_email', 'manager_email', 'sco', 'job_title']
const SCO_CODE_COLUMNS = ['zone', 'area', 'ou', 'code']

// Header-name-based. manager_email is allowed to be blank — no manager on
// file is a real, known state in the source data (e.g. the org's top exec,
// or a row Workday itself has incomplete), not an error. job_title is also
// allowed to be blank until the source sheet has that column populated.
function parseTeamHierarchy(text) {
  const parsed = parseCsv(text)
  if (parsed.length < 2) throw new Error('CSV has no data rows')
  const header = parsed[0].map(h => h.trim().toLowerCase())
  if (!header.includes('primary_email')) throw new Error('Missing required column: primary_email')
  return parsed.slice(1).map(cols => {
    const obj = {}
    header.forEach((h, i) => { if (TEAM_HIERARCHY_COLUMNS.includes(h)) obj[h] = (cols[i] || '').trim() })
    return obj
  })
}

// Header-name-based. Only 'code' and 'ou' are required — area/zone are
// stored since the Sheet has them, but nothing reads them yet.
function parseScoCodes(text) {
  const parsed = parseCsv(text)
  if (parsed.length < 2) throw new Error('CSV has no data rows')
  const header = parsed[0].map(h => h.trim().toLowerCase())
  const missing = ['code', 'ou'].filter(c => !header.includes(c))
  if (missing.length) throw new Error(`Missing required column(s): ${missing.join(', ')}`)
  return parsed.slice(1).map(cols => {
    const obj = {}
    header.forEach((h, i) => { if (SCO_CODE_COLUMNS.includes(h)) obj[h] = (cols[i] || '').trim() })
    return obj
  })
}

// Header-name-based: fine for a hand-made CSV with clean headers.
function parseQuickSubscriptions(text) {
  const parsed = parseCsv(text)
  if (parsed.length < 2) throw new Error('CSV has no data rows')
  const header = parsed[0].map(h => h.trim().toLowerCase())
  const missing = ['user_email', 'license_name', 'suite_key'].filter(c => !header.includes(c))
  if (missing.length) throw new Error(`Missing required column(s): ${missing.join(', ')}`)
  return parsed.slice(1).map(cols => {
    const obj = {}
    header.forEach((h, i) => { if (EXPECTED_COLUMNS.includes(h)) obj[h] = (cols[i] || '').trim() })
    return obj
  })
}

// GAS's Licenses sheet has a header-drift bug — initializeAppSheet() only ever
// wrote 8 header cells, but saveLicense() has always written 20 columns of
// data — so column 8 onward has no reliable header name to match against.
// Positional mapping is the only option; see admin_import_licenses() in
// supabase/pending/17_gas_historical_import.sql for what each field expects.
function parseGasLicenses(text) {
  const parsed = parseCsv(text)
  if (parsed.length < 2) throw new Error('CSV has no data rows')
  return parsed.slice(1).map(r => ({
    legacy_id: r[0], name: r[1], vendor: r[2], category: r[3], price: r[4],
    notes: r[6], active: r[7], gtis_sponsored: r[8], billing_cycle: r[9],
    renewal_month: r[10], renewal_reminder: r[11], created_by_email: r[12],
    logo_url: r[13], activation_url: r[14],
    // r[15] ("activated") is intentionally dropped — see admin_import_licenses().
    more_info_url: r[16], google_group_email: r[17], pro_rated: r[18], service_manager_email: r[19],
  }))
}

// Same header-drift issue as Licenses — positional mapping.
function parseGasSubscriptions(text) {
  const parsed = parseCsv(text)
  if (parsed.length < 2) throw new Error('CSV has no data rows')
  return parsed.slice(1).map(r => ({
    legacy_id: r[0], user_email: r[1], license_name: r[2], license_legacy_id: r[3],
    suite_key: r[4], start_date: r[5], fy: r[6], status: r[7], renewal_status: r[8],
    billing_cycle: r[9], renewal_month: r[10], renewal_reminder: r[11], price_at_signup: r[13],
  }))
}

// GAS's AuditLog sheet has clean, complete headers — no drift.
function parseGasAuditLog(text) {
  const parsed = parseCsv(text)
  if (parsed.length < 2) throw new Error('CSV has no data rows')
  return parsed.slice(1).map(r => ({
    legacy_id: r[0], timestamp: r[1], action: r[2], subscription_legacy_id: r[3],
    license_name: r[4], user_email: r[5], suite_key: r[6], performed_by: r[7], notes: r[8],
  }))
}

// Shared shape for every importer below: pick a file, see a preview + count,
// import, see per-row ok/fail results. Never lets one bad row fail the batch.
function ImportSection({ title, description, sourceUrl, previewColumns, rowLabel, parse, doImport }) {
  const [fileName, setFileName] = useState('')
  const [rows, setRows] = useState(null)
  const [results, setResults] = useState(null)
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
        setRows(parse(String(reader.result)))
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
      setResults(await doImport(rows))
    } catch (err) {
      setError(err.message)
    } finally {
      setImporting(false)
    }
  }

  const successCount = results?.filter(r => r.ok).length ?? 0
  const failCount = results ? results.length - successCount : 0

  return (
    <div className="bg-white rounded-xl shadow-xs p-6 mb-6">
      <h2 className="font-display text-lg font-bold text-brand mb-1 flex items-center gap-1.5">
        {title}
        {sourceUrl && (
          <a href={sourceUrl} target="_blank" rel="noreferrer" title="Open source spreadsheet" className="text-gray-400 hover:text-brand">
            <ExternalLink size={15} />
          </a>
        )}
      </h2>
      <p className="text-xs text-gray-400 mb-4">{description}</p>

      <input type="file" accept=".csv" onChange={handleFile} className="text-sm mb-4" />

      {error && <p className="text-sil-red mb-4">{error}</p>}

      {rows && !results && (
        <>
          <p className="text-sm text-gray-700 mb-3">
            {fileName}: {rows.length} row{rows.length === 1 ? '' : 's'} parsed. Review, then import.
          </p>
          <div className="border border-gray-100 rounded-lg overflow-x-auto mb-4">
            <table className="w-full text-sm">
              <thead className="text-left text-gray-400 border-b">
                <tr>{previewColumns.map(c => <th key={c} className="p-2">{c}</th>)}</tr>
              </thead>
              <tbody className="divide-y">
                {rows.slice(0, 10).map((r, i) => (
                  <tr key={i}>{previewColumns.map(c => <td key={c} className="p-2">{r[c] || ''}</td>)}</tr>
                ))}
              </tbody>
            </table>
            {rows.length > 10 && <p className="text-xs text-gray-400 p-2">…and {rows.length - 10} more</p>}
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
            {failCount > 0 && <span className="text-sil-red font-medium">, {failCount} skipped/failed</span>}
          </p>
          <div className="border border-gray-100 rounded-lg overflow-x-auto max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-gray-400 border-b">
                <tr>
                  <th className="p-2">Row</th>
                  <th className="p-2">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {results.map((r, i) => (
                  <tr key={i}>
                    <td className="p-2 text-gray-500">{rowLabel(r.row)}</td>
                    <td className={`p-2 ${r.ok ? 'text-sil-green' : 'text-sil-red'}`}>{r.ok ? 'Imported' : r.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// The GAS historical backfill (Licenses -> Subscriptions -> Audit Log) has
// already been run to completion — flip this back on if a one-off historical
// correction ever needs it again, rather than re-adding the sections from
// scratch.
const SHOW_GAS_IMPORT = false

export default function AdminImport() {
  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-6xl mx-auto p-6">
        <AdminTabs />
        <h1 className="font-display text-2xl font-bold text-brand mb-2">Import</h1>
        <p className="text-sm text-gray-500 mb-6">
          {SHOW_GAS_IMPORT
            ? "One-time historical backfill from the GAS project, plus a quick manual-entry importer. Run the GAS sections in order — Licenses, then Subscriptions, then Audit Log — since each later one depends on the previous. Every row is safe to re-import: already-imported rows (matched by the GAS sheet's own ID) are skipped, not duplicated or overwritten."
            : 'Quick manual-entry importer for already-active subscriptions.'}
        </p>

        {SHOW_GAS_IMPORT && (
          <>
            <ImportSection
              title="GAS: Licenses"
              description={'Upload the GAS "Licenses" sheet export as-is (CSV). Column order matters — headers are ignored.'}
              previewColumns={['legacy_id', 'name', 'vendor', 'billing_cycle', 'active']}
              rowLabel={row => row.name}
              parse={parseGasLicenses}
              doImport={importLicenses}
            />

            <ImportSection
              title="GAS: Subscriptions (full history)"
              description={'Upload the GAS "Subscriptions" sheet export as-is (CSV). Preserves each row’s real historical status — run the Licenses import first.'}
              previewColumns={['legacy_id', 'user_email', 'license_name', 'status', 'fy']}
              rowLabel={row => `${row.user_email} · ${row.license_name}`}
              parse={parseGasSubscriptions}
              doImport={importSubscriptionsFull}
            />

            <ImportSection
              title="GAS: Audit Log"
              description={'Upload the GAS "AuditLog" sheet export as-is (CSV). Run the Subscriptions import first so each row can link back to its subscription.'}
              previewColumns={['legacy_id', 'timestamp', 'action', 'user_email', 'performed_by']}
              rowLabel={row => `${row.timestamp} · ${row.action} · ${row.user_email}`}
              parse={parseGasAuditLog}
              doImport={importAuditLog}
            />
          </>
        )}

        <ImportSection
          title="Team hierarchy"
          sourceUrl="https://docs.google.com/spreadsheets/d/1bSv4fta7p-TkFUnKZUKMSLkjp2wquMzyHp2N6OBGKbA/edit?gid=0#gid=0"
          description={'Upload a weekly export of the org-hierarchy Sheet to update who reports to whom (drives the My Team page). Required column: primary_email — creates a placeholder profile if that person hasn’t signed in yet (skipped if the email isn’t an eligible SIL staff domain). Optional: manager_email — leave blank for anyone with no manager on file, which is a known reality of the source data, not an error. Optional: sco (a 3-letter org code) — drives department-gated licensing and, via the SCO codes import below, the department name shown in provisioning emails.'}
          previewColumns={TEAM_HIERARCHY_COLUMNS}
          rowLabel={row => `${row.primary_email} → ${row.manager_email || '(no manager)'}`}
          parse={parseTeamHierarchy}
          doImport={importTeamHierarchy}
        />

        <ImportSection
          title="SCO codes"
          sourceUrl="https://docs.google.com/spreadsheets/d/1C7FK-6sZB5nETIyJeTGHVteaesSniLkAWrKaI1ONyhU/edit?gid=474403988#gid=474403988"
          description={'Upload an export of the org-structure Sheet (Zone/Area/OU/Code) to update the department names shown in provisioning emails. Required columns: code (3-letter SCO code), ou (department name). Optional: area, zone — captured but not used anywhere in the app yet. Changes far less often than Team hierarchy; only re-run this when the org structure itself changes.'}
          previewColumns={SCO_CODE_COLUMNS}
          rowLabel={row => `${row.code} → ${row.ou}`}
          parse={parseScoCodes}
          doImport={importScoCodes}
        />

        <ImportSection
          title="Quick subscription import"
          description={'Bulk-import already-active subscriptions from a hand-made CSV — no approval emails, no verification step, no history. Required columns: user_email, license_name, suite_key (a real SuiteKey, a 6-digit Ministry ID, or blank for GTIS-sponsored licenses). Optional: start_date, fy, requester_email (who actually requested it, if different from user_email — defaults to you; creates a placeholder profile if that person hasn’t signed in yet).'}
          previewColumns={EXPECTED_COLUMNS}
          rowLabel={row => `${row.user_email} · ${row.license_name}`}
          parse={parseQuickSubscriptions}
          doImport={importSubscriptions}
        />
      </div>
    </AppLayout>
  )
}

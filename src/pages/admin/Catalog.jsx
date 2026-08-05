import { useEffect, useMemo, useState } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown, X } from 'lucide-react'
import AppLayout from '../../components/AppLayout'
import AdminTabs from '../../components/AdminTabs'
import { getLinks } from '../../navLinks'
import { getAllLicenses, saveLicense, deactivateLicense, reactivateLicense } from '../../lib/licenses'
import { activationEmailHtml, renewalReminderCardHtml, renewalReminderEmailHtml } from '../../lib/email'

const BLANK = {
  id: null, name: '', vendor: '', category: '', price: '',
  gtis_sponsored: false, billing_cycle: 'annual', renewal_month: 10, renewal_reminder: true,
  activation_url: '', more_info_url: '', logo_url: '', google_group_email: '',
  pro_rated: false, service_manager_email: '', onboarding_message: '', reminder_message: '',
  provisioning_adapter: '', provisioning_config: '',
}

// Sample data for the Preview buttons in the email-overrides section — no
// real subscription exists yet while editing a license, so this stands in
// for one closely enough to render what the real thing would look like.
const PREVIEW_SUB = { billing_type: 'suite_key', suite_key: 'SAMPLE-001', billing_cycle: 'annual', fy: new Date().getFullYear() }

// Known sync-provisioning adapters (see supabase/functions/sync-provisioning/adapters/).
// Adding a new one is just another entry here + an adapter file — no other
// admin-UI changes needed, since provisioning_config is a generic JSON blob.
const PROVISIONING_ADAPTERS = [
  { value: '', label: 'None (manual)' },
  { value: 'cubebackup', label: 'CubeBackup', configHint: '{"baseUrl": "https://cubebackup.example.org", "domain": "sil.org"}' },
]

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const PRICE_UNITS = { annual: 'per seat/year', monthly: 'per seat/month', one_time: 'one-time' }

function billingLabel(license) {
  if (license.billing_cycle === 'monthly') return 'Monthly'
  if (license.billing_cycle === 'one_time') return 'One-time'
  if (!license.renewal_month) return '—'
  return `${String(license.renewal_month).padStart(2, '0')} - ${MONTH_NAMES[license.renewal_month - 1]}`
}

// Each column's sort() returns a directly-comparable value — keeps the
// header-click handler and the actual comparator generic across columns
// instead of a big switch statement.
const COLUMNS = [
  { key: 'name', label: 'Name', sort: l => l.name.toLowerCase() },
  { key: 'vendor', label: 'Vendor', sort: l => (l.vendor || '').toLowerCase() },
  { key: 'category', label: 'Category', sort: l => (l.category || '').toLowerCase() },
  { key: 'price', label: 'Price', sort: l => Number(l.price) || 0, align: 'right' },
  { key: 'billing', label: 'Billing', sort: l => (l.billing_cycle === 'monthly' ? 0 : l.renewal_month || 0) },
  { key: 'paid_by', label: 'Paid By', sort: l => (l.gtis_sponsored ? 'GTIS' : 'User') },
  { key: 'active', label: 'Active', sort: l => (l.active ? 1 : 0) },
]

export default function AdminCatalog() {
  const [licenses, setLicenses] = useState(null)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null) // license object, or BLANK for "new"
  const [showLogoInput, setShowLogoInput] = useState(false)
  const [preview, setPreview] = useState(null) // { title, html } | null
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('name')
  const [sortDir, setSortDir] = useState('asc')

  function openEditor(license) {
    setEditing({
      ...license,
      // provisioning_config comes back from the DB as a real jsonb object
      // (or null) — the form edits it as raw JSON text, so stringify it here
      // and parse it back on save.
      provisioning_config: license.provisioning_config ? JSON.stringify(license.provisioning_config, null, 2) : '',
    })
    setShowLogoInput(false)
  }

  function handleSort(key) {
    if (key === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  function reload() {
    getAllLicenses().then(setLicenses).catch(e => setError(e.message))
  }

  useEffect(reload, [])

  async function handleSave(e) {
    e.preventDefault()
    // Only annual licenses have a meaningful renewal month — monthly bills
    // prorate by day-of-month and one-time purchases don't renew at all (see
    // calc_prorated_cost() in schema_licenses.sql, which never reads
    // renewal_month for either of those).
    const renewalMonth = editing.billing_cycle === 'annual'
      ? (editing.renewal_month === '' ? null : Number(editing.renewal_month))
      : null
    if (editing.billing_cycle === 'annual' && (renewalMonth == null || renewalMonth < 1 || renewalMonth > 12)) {
      setError('Renewal month must be between 1 and 12.')
      return
    }
    const configText = editing.provisioning_config.trim()
    if (configText) {
      try {
        JSON.parse(configText)
      } catch {
        setError('Provisioning config must be valid JSON (or left blank).')
        return
      }
    }
    try {
      await saveLicense({
        ...editing,
        price: editing.price === '' ? null : Number(editing.price),
        price_unit: PRICE_UNITS[editing.billing_cycle],
        renewal_month: renewalMonth,
        provisioning_config: configText || null,
      })
      setEditing(null)
      setError(null)
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleDeactivate() {
    if (!confirm(`Deactivate ${editing.name}? Existing subscriptions are unaffected, but no new subscriptions can be requested for it.`)) return
    try {
      await deactivateLicense(editing.id)
      setEditing(null)
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleReactivate() {
    if (!confirm(`Reactivate ${editing.name}? It'll show up in the Catalog again.`)) return
    try {
      await reactivateLicense(editing.id)
      setEditing(null)
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

  function previewOnboarding() {
    setPreview({
      title: 'Onboarding email preview',
      html: activationEmailHtml({
        sub: PREVIEW_SUB,
        licenseName: editing.name || 'Sample License',
        onboardingMessage: editing.onboarding_message || null,
      }),
    })
  }

  function previewReminder() {
    const card = renewalReminderCardHtml({
      licenseName: editing.name || 'Sample License',
      suiteKey: PREVIEW_SUB.suite_key,
      priceLabel: editing.price ? `$${Number(editing.price).toFixed(2)}/${editing.billing_cycle === 'monthly' ? 'mo' : 'yr'}` : null,
      renewalLabel: 'October 1, 2026',
      reminderMessage: editing.reminder_message || null,
    })
    setPreview({ title: 'Renewal reminder preview', html: renewalReminderEmailHtml({ cardsHtml: card }) })
  }

  const q = search.trim().toLowerCase()
  const filteredLicenses = !q ? licenses : licenses?.filter(l =>
    l.name.toLowerCase().includes(q) ||
    (l.vendor || '').toLowerCase().includes(q) ||
    (l.category || '').toLowerCase().includes(q)
  )
  const visibleLicenses = useMemo(() => {
    if (!filteredLicenses) return filteredLicenses
    const col = COLUMNS.find(c => c.key === sortKey)
    const sorted = [...filteredLicenses].sort((a, b) => {
      const av = col.sort(a), bv = col.sort(b)
      return av < bv ? -1 : av > bv ? 1 : 0
    })
    return sortDir === 'desc' ? sorted.reverse() : sorted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredLicenses, sortKey, sortDir])

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-6xl mx-auto p-6">
        <AdminTabs />
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-display text-2xl font-bold text-brand">Admin — Catalog</h1>
          <button onClick={() => openEditor(BLANK)} className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2">
            + New license
          </button>
        </div>

        {error && <p className="text-sil-red mb-4">{error}</p>}

        {licenses?.length > 0 && (
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by name, vendor, or category…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-4"
          />
        )}
        {licenses?.length > 0 && visibleLicenses.length === 0 && (
          <p className="text-gray-400 mb-4">No licenses match "{search}".</p>
        )}

        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-gray-400 border-b">
              <tr>
                {COLUMNS.map(col => (
                  <th key={col.key} className={`p-3 ${col.align === 'right' ? 'text-right' : ''}`}>
                    <button
                      onClick={() => handleSort(col.key)}
                      className={`flex items-center gap-1 font-semibold uppercase text-xs tracking-wide hover:text-gray-600 ${col.align === 'right' ? 'ml-auto' : ''}`}
                    >
                      {col.label}
                      {sortKey === col.key
                        ? (sortDir === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} />)
                        : <ChevronsUpDown size={13} className="text-gray-300" />}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {visibleLicenses?.map(license => (
                <tr
                  key={license.id}
                  onClick={() => openEditor(license)}
                  className="cursor-pointer hover:bg-gray-50 transition-colors"
                >
                  <td className={`p-3 font-medium ${license.active ? 'text-brand' : 'text-gray-400 line-through'}`}>{license.name}</td>
                  <td className="p-3 text-gray-500">{license.vendor}</td>
                  <td className="p-3 text-gray-500">{license.category}</td>
                  <td className="p-3 text-gray-700 text-right">{license.price != null ? `$${Number(license.price).toFixed(2)}` : '—'}</td>
                  <td className="p-3 text-gray-500 whitespace-nowrap">{billingLabel(license)}</td>
                  <td className="p-3 text-gray-500">{license.gtis_sponsored ? 'GTIS' : 'User'}</td>
                  <td className="p-3">
                    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${license.active ? 'bg-sil-green/10 text-sil-green' : 'bg-gray-100 text-gray-400'}`}>
                      {license.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 overflow-y-auto">
          <form onSubmit={handleSave} className="bg-white rounded-2xl shadow-lg p-8 max-w-2xl w-full my-8">
            <h2 className="font-display text-xl font-bold text-brand mb-4">{editing.id ? 'Edit license' : 'New license'}</h2>
            {error && <p className="text-sil-red text-sm mb-3">{error}</p>}

            <div className="flex items-start gap-3 mb-3">
              <div className="h-14 w-14 shrink-0 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center overflow-hidden">
                {editing.logo_url
                  ? <img src={editing.logo_url} alt="" className="h-full w-full object-contain" />
                  : <span className="text-[10px] text-gray-300 text-center px-1">No logo</span>}
              </div>
              <div className="flex-1">
                <Field label="Name" value={editing.name} onChange={v => setEditing({ ...editing, name: v })} required />
                {showLogoInput || !editing.logo_url ? (
                  <div className="mt-1">
                    <Field label="Logo URL" value={editing.logo_url} onChange={v => setEditing({ ...editing, logo_url: v })} />
                  </div>
                ) : (
                  <button type="button" onClick={() => setShowLogoInput(true)} className="mt-1 text-xs font-medium text-brand">
                    Change logo
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Field label="Vendor" value={editing.vendor} onChange={v => setEditing({ ...editing, vendor: v })} />
              <Field label="Category" value={editing.category} onChange={v => setEditing({ ...editing, category: v })} />

              <Field label="Price" type="number" value={editing.price} onChange={v => setEditing({ ...editing, price: v })} />
              <label className="text-sm text-gray-700">
                Billing cycle
                <select value={editing.billing_cycle}
                  onChange={e => setEditing({
                    ...editing, billing_cycle: e.target.value,
                    ...(e.target.value === 'annual'
                      ? { renewal_month: editing.renewal_month || 10, renewal_reminder: true }
                      : { renewal_month: '', renewal_reminder: false }),
                  })}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                  <option value="annual">Annual</option>
                  <option value="monthly">Monthly</option>
                  <option value="one_time">One-time (not recurring)</option>
                </select>
              </label>

              {editing.billing_cycle === 'annual' && (
                <Field label="Renewal month (1-12)" type="number" min={1} max={12} value={editing.renewal_month} onChange={v => setEditing({ ...editing, renewal_month: v })} />
              )}
              <div className={`flex flex-col justify-center gap-1.5 text-sm ${editing.billing_cycle !== 'annual' ? 'col-span-2' : ''}`}>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={editing.gtis_sponsored} onChange={e => setEditing({ ...editing, gtis_sponsored: e.target.checked })} />
                  GTIS-sponsored (no approval needed)
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={editing.pro_rated} onChange={e => setEditing({ ...editing, pro_rated: e.target.checked })} />
                  Pro-rated
                </label>
              </div>

              <Field label="Activation URL" value={editing.activation_url} onChange={v => setEditing({ ...editing, activation_url: v })}
                hint="Set this if activation needs manual admin/service-manager provisioning after approval." />
              <Field label="Service manager email" value={editing.service_manager_email} onChange={v => setEditing({ ...editing, service_manager_email: v })} />

              <Field label="More info URL" value={editing.more_info_url} onChange={v => setEditing({ ...editing, more_info_url: v })} />
              <Field label="Google Group email" value={editing.google_group_email} onChange={v => setEditing({ ...editing, google_group_email: v })}
                hint="Not automated yet — see supabase/schema_licenses.sql notes." />

              <label className="text-sm text-gray-700">
                Provisioning
                <select value={editing.provisioning_adapter}
                  onChange={e => setEditing({ ...editing, provisioning_adapter: e.target.value })}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                  {PROVISIONING_ADAPTERS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
                <span className="block text-xs text-gray-400 mt-0.5">
                  Automatically enable/disable the user in an external vendor system on activation/cancellation (in addition to, or instead of, the manual Activation URL above).
                </span>
              </label>
              {editing.provisioning_adapter && (
                <label className="block text-sm text-gray-700">
                  Provisioning config (JSON)
                  <textarea
                    value={editing.provisioning_config}
                    onChange={e => setEditing({ ...editing, provisioning_config: e.target.value })}
                    rows={2}
                    placeholder={PROVISIONING_ADAPTERS.find(a => a.value === editing.provisioning_adapter)?.configHint}
                    className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-xs"
                  />
                </label>
              )}

              <details className="col-span-2 border border-gray-200 rounded-lg px-3 py-2">
                <summary className="text-sm font-medium text-gray-700 cursor-pointer select-none">Email overrides</summary>
                <div className="mt-3 space-y-4">
                  <label className="block text-sm text-gray-700">
                    Onboarding email override
                    <textarea
                      value={editing.onboarding_message ?? ''}
                      onChange={e => setEditing({ ...editing, onboarding_message: e.target.value })}
                      rows={2}
                      placeholder="Leave blank to use the default &quot;your license is ready&quot; message"
                      className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                    <span className="block text-xs text-gray-400 mt-0.5">
                      Replaces the default activation email body for this license — e.g. setup steps a generic message wouldn't cover.
                    </span>
                    <button type="button" onClick={previewOnboarding} className="mt-1 text-xs font-medium text-brand">Preview</button>
                  </label>

                  <label className="block text-sm text-gray-700">
                    Renewal reminder override
                    <textarea
                      value={editing.reminder_message ?? ''}
                      onChange={e => setEditing({ ...editing, reminder_message: e.target.value })}
                      rows={2}
                      placeholder="Leave blank to use the default renewal-reminder message"
                      className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                    />
                    <span className="block text-xs text-gray-400 mt-0.5">
                      Replaces the default text in this license's card within the renewal-reminder digest. Content only for
                      now — the weekly digest itself isn't automated yet (see supabase/schema_licenses.sql notes).
                    </span>
                    <button type="button" onClick={previewReminder} className="mt-1 text-xs font-medium text-brand">Preview</button>
                  </label>
                </div>
              </details>
            </div>

            <div className="flex items-center justify-between pt-4">
              <div className="flex gap-3">
                <button type="submit" className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2">Save</button>
                <button type="button" onClick={() => setEditing(null)} className="text-sm font-medium text-gray-500">Cancel</button>
              </div>
              {editing.id && (
                editing.active
                  ? <button type="button" onClick={handleDeactivate} className="text-sm font-medium text-sil-red">Deactivate</button>
                  : <button type="button" onClick={handleReactivate} className="text-sm font-medium text-sil-green">Reactivate</button>
              )}
            </div>
          </form>
        </div>
      )}

      {preview && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={() => setPreview(null)}>
          <div className="bg-white rounded-2xl shadow-lg w-full max-w-3xl h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 flex-shrink-0">
              <h3 className="font-semibold text-gray-900 text-sm">{preview.title}</h3>
              <button type="button" onClick={() => setPreview(null)} aria-label="Close" className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <iframe title="Email preview" srcDoc={preview.html} className="w-full flex-1 rounded-b-2xl" />
          </div>
        </div>
      )}
    </AppLayout>
  )
}

function Field({ label, value, onChange, type = 'text', required, placeholder, hint, min, max }) {
  return (
    <label className="block text-sm text-gray-700">
      {label}
      <input
        type={type}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        min={min}
        max={max}
        className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
      />
      {hint && <span className="block text-xs text-gray-400 mt-0.5">{hint}</span>}
    </label>
  )
}

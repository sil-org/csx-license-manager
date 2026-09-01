import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown, X, Bold, Italic, List, Link as LinkIcon } from 'lucide-react'
import AppLayout from '../../components/AppLayout'
import AdminTabs from '../../components/AdminTabs'
import { getLinks } from '../../navLinks'
import {
  getAllLicenses, saveLicense, deactivateLicense, reactivateLicense,
  listDepartmentApprovals, addDepartmentApproval, removeDepartmentApproval,
  sizeAwareSort,
} from '../../lib/licenses'
import { activationEmailHtml, renewalReminderCardHtml, renewalReminderEmailHtml } from '../../lib/email'

const BLANK = {
  id: null, name: '', vendor: '', category: '', price: '', notes: '',
  gtis_sponsored: false, billing_cycle: 'annual', renewal_month: 10, renewal_reminder: true,
  activation_url: '', more_info_url: '', logo_url: '', google_group_email: '',
  pro_rated: false, service_manager_emails: '', onboarding_message: '', reminder_message: '',
  provisioning_adapter: '', provisioning_config: '',
  provisioning_email_show_name: false, provisioning_email_show_job_title: false, provisioning_email_show_department: false,
  department_gated: false,
  requires_acknowledgement: false, acknowledgement_text: '',
  extra_field_label: '', extra_field_required: false,
  allow_multiple_per_person: false,
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

const PRICE_UNITS = { annual: 'per year', monthly: 'per month', one_time: 'one-time' }

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
  { key: 'name', label: 'Name', sort: l => sizeAwareSort(l.name) },
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
      // and parse it back on save. service_manager_emails is a real text[]
      // for the same reason — edited as a comma-separated string, split back
      // into an array on save.
      provisioning_config: license.provisioning_config ? JSON.stringify(license.provisioning_config, null, 2) : '',
      service_manager_emails: (license.service_manager_emails || []).join(', '),
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
    if (editing.requires_acknowledgement && !editing.acknowledgement_text?.trim()) {
      setError('Terms & Conditions text is required when acknowledgement is required.')
      return
    }
    try {
      await saveLicense({
        ...editing,
        price: editing.price === '' ? null : Number(editing.price),
        price_unit: PRICE_UNITS[editing.billing_cycle],
        renewal_month: renewalMonth,
        provisioning_config: configText || null,
        service_manager_emails: editing.service_manager_emails.split(',').map(e => e.trim()).filter(Boolean),
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

              <label className="col-span-2 block text-sm text-gray-700">
                Description
                <RichTextEditor
                  value={editing.notes ?? ''}
                  onChange={html => setEditing({ ...editing, notes: html })}
                  placeholder="Shown to staff in the Catalog before they subscribe — what it's for, what's included, any caveats."
                />
              </label>

              <Field label="Activation URL" value={editing.activation_url} onChange={v => setEditing({ ...editing, activation_url: v })}
                hint="Vendor admin portal link, shown to whoever provisions this license once it's approved — every subscription needs an explicit 'Mark active' regardless of whether this is set." />
              <Field label="Service manager email(s)" value={editing.service_manager_emails} onChange={v => setEditing({ ...editing, service_manager_emails: v })}
                hint="Comma-separated if more than one — everyone listed gets the same provisioning email." />

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
                <summary className="text-sm font-medium text-gray-700 cursor-pointer select-none">More settings</summary>
                <div className="mt-3 space-y-4">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={editing.department_gated} onChange={e => setEditing({ ...editing, department_gated: e.target.checked })} />
                    Department-gated (free; departments opt in to approval below)
                  </label>

                  {editing.id && editing.department_gated && <DepartmentApprovals licenseId={editing.id} />}

                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={editing.allow_multiple_per_person} onChange={e => setEditing({ ...editing, allow_multiple_per_person: e.target.checked })} />
                    Allow multiple per person (e.g. a person can hold more than one Shared Drive)
                  </label>

                  <div className="space-y-1.5">
                    <Field label="Extra field label" value={editing.extra_field_label} onChange={v => setEditing({ ...editing, extra_field_label: v })}
                      placeholder='e.g. "Shared Drive name"'
                      hint="Asks requesters for one more piece of text at request time — shown in Admin -> All Subscriptions' details popup. Leave blank for none." />
                    {editing.extra_field_label && (
                      <label className="flex items-center gap-2 text-sm text-gray-700">
                        <input type="checkbox" checked={editing.extra_field_required} onChange={e => setEditing({ ...editing, extra_field_required: e.target.checked })} />
                        Required
                      </label>
                    )}
                  </div>

                  <div className="text-sm text-gray-700">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={editing.requires_acknowledgement} onChange={e => setEditing({ ...editing, requires_acknowledgement: e.target.checked })} />
                      Require Terms &amp; Conditions acknowledgement before requesting
                    </label>
                    {editing.requires_acknowledgement && (
                      <RichTextEditor
                        value={editing.acknowledgement_text ?? ''}
                        onChange={html => setEditing({ ...editing, acknowledgement_text: html })}
                        placeholder="Shown to staff in the request form, next to a required &quot;I agree&quot; checkbox — link to the actual terms document here."
                      />
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5 text-sm">
                    <span className="text-gray-700">Also include in the provisioning email (most service managers only want the email address above):</span>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={editing.provisioning_email_show_name} onChange={e => setEditing({ ...editing, provisioning_email_show_name: e.target.checked })} />
                      Name
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={editing.provisioning_email_show_job_title} onChange={e => setEditing({ ...editing, provisioning_email_show_job_title: e.target.checked })} />
                      Job title
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={editing.provisioning_email_show_department} onChange={e => setEditing({ ...editing, provisioning_email_show_department: e.target.checked })} />
                      Department
                    </label>
                  </div>

                  <label className="block text-sm text-gray-700">
                    Onboarding email override
                    <RichTextEditor
                      value={editing.onboarding_message ?? ''}
                      onChange={html => setEditing({ ...editing, onboarding_message: html })}
                      placeholder="Leave blank to use the default &quot;your license is ready&quot; message"
                    />
                    <span className="block text-xs text-gray-400 mt-0.5">
                      Replaces the default activation email body for this license — e.g. setup steps a generic message wouldn't cover.
                    </span>
                    <button type="button" onClick={previewOnboarding} className="mt-1 text-xs font-medium text-brand">Preview</button>
                  </label>

                  <label className="block text-sm text-gray-700">
                    Renewal reminder override
                    <RichTextEditor
                      value={editing.reminder_message ?? ''}
                      onChange={html => setEditing({ ...editing, reminder_message: html })}
                      placeholder="Leave blank to use the default renewal-reminder message"
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

// Minimal WYSIWYG editor for the email-override fields — these values get
// dropped straight into the outgoing email HTML unescaped (see
// activationEmailHtml/renewalReminderCardHtml in lib/email.js), so what's
// authored here is exactly what recipients see. Uses contentEditable +
// execCommand rather than pulling in a rich-text dependency, since the
// formatting needs are just bold/italic/list/link.
const RTE_COMMANDS = [
  { command: 'bold', icon: Bold, title: 'Bold' },
  { command: 'italic', icon: Italic, title: 'Italic' },
  { command: 'insertUnorderedList', icon: List, title: 'Bulleted list' },
]

function RichTextEditor({ value, onChange, placeholder }) {
  const ref = useRef(null)

  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== (value || '')) {
      ref.current.innerHTML = value || ''
    }
  }, [value])

  function exec(command, arg) {
    ref.current.focus()
    document.execCommand(command, false, arg)
    onChange(ref.current.innerHTML)
  }

  function handleLink() {
    const url = window.prompt('Link URL (leave blank to remove an existing link)')
    if (url === null) return
    ref.current.focus()
    document.execCommand(url ? 'createLink' : 'unlink', false, url || undefined)
    onChange(ref.current.innerHTML)
  }

  return (
    <div className="mt-1 w-full border border-gray-300 rounded-lg overflow-hidden focus-within:ring-1 focus-within:ring-brand">
      <div className="flex items-center gap-0.5 border-b border-gray-200 bg-gray-50 px-1.5 py-1">
        {RTE_COMMANDS.map(({ command, icon: Icon, title }) => (
          <button
            key={command}
            type="button"
            title={title}
            onMouseDown={e => e.preventDefault()}
            onClick={() => exec(command)}
            className="p-1 rounded text-gray-600 hover:bg-gray-200"
          >
            <Icon size={14} />
          </button>
        ))}
        <button
          type="button"
          title="Link"
          onMouseDown={e => e.preventDefault()}
          onClick={handleLink}
          className="p-1 rounded text-gray-600 hover:bg-gray-200"
        >
          <LinkIcon size={14} />
        </button>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={e => onChange(e.currentTarget.innerHTML)}
        data-placeholder={placeholder}
        className="px-3 py-2 text-sm min-h-[4.5rem] focus:outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400"
      />
    </div>
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

// Inline list/add/remove UI for a department-gated license's opt-in approval
// list (sco -> approver email) — see request_subscription()'s
// department_gated branch in supabase/pending/40_department_gated_licenses.sql.
// Departments not listed here are simply auto-approved, same as
// gtis_sponsored today.
function DepartmentApprovals({ licenseId }) {
  const [rows, setRows] = useState(null)
  const [sco, setSco] = useState('')
  const [approverEmail, setApproverEmail] = useState('')
  const [error, setError] = useState(null)

  function reload() {
    listDepartmentApprovals(licenseId).then(setRows).catch(e => setError(e.message))
  }

  useEffect(reload, [licenseId])

  async function handleAdd(e) {
    e.preventDefault()
    setError(null)
    try {
      await addDepartmentApproval(licenseId, sco, approverEmail)
      setSco('')
      setApproverEmail('')
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleRemove(id) {
    try {
      await removeDepartmentApproval(id)
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="border border-gray-200 rounded-lg px-3 py-3">
      <p className="text-sm font-medium text-gray-700 mb-2">Departments requiring approval (by SCO code)</p>
      {error && <p className="text-sm text-sil-red mb-2">{error}</p>}
      {rows?.length > 0 && (
        <ul className="space-y-1 mb-3">
          {rows.map(r => (
            <li key={r.id} className="flex items-center justify-between text-sm bg-gray-50 rounded px-2 py-1">
              <span><strong>{r.sco}</strong> → {r.approver_email}</span>
              <button type="button" onClick={() => handleRemove(r.id)} className="text-gray-400 hover:text-sil-red" aria-label={`Remove ${r.sco}`}>
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2 items-end">
        <label className="block text-xs text-gray-600">
          SCO code
          <input value={sco} onChange={e => setSco(e.target.value)} maxLength={3} placeholder="ENG"
            className="mt-1 w-20 border border-gray-300 rounded-lg px-2 py-1.5 text-sm uppercase" />
        </label>
        <label className="text-xs text-gray-600 flex-1">
          Approver email
          <input type="email" value={approverEmail} onChange={e => setApproverEmail(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm" />
        </label>
        <button type="button" onClick={handleAdd} disabled={!sco.trim() || !approverEmail.trim()}
          className="text-sm font-medium bg-brand text-white rounded-lg px-3 py-1.5 disabled:opacity-40">
          Add
        </button>
      </div>
    </div>
  )
}

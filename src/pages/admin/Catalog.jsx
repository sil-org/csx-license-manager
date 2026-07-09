import { useEffect, useState } from 'react'
import AppLayout from '../../components/AppLayout'
import { getLinks } from '../../navLinks'
import { getAllLicenses, saveLicense, deactivateLicense } from '../../lib/licenses'

const BLANK = {
  id: null, name: '', vendor: '', category: '', price: '', price_unit: '',
  gtis_sponsored: false, billing_cycle: 'annual', renewal_month: '', renewal_reminder: true,
  activation_url: '', more_info_url: '', logo_url: '', google_group_email: '',
  pro_rated: false, service_manager_email: '',
}

export default function AdminCatalog() {
  const [licenses, setLicenses] = useState(null)
  const [error, setError] = useState(null)
  const [editing, setEditing] = useState(null) // license object, or BLANK for "new"

  function reload() {
    getAllLicenses().then(setLicenses).catch(e => setError(e.message))
  }

  useEffect(reload, [])

  async function handleSave(e) {
    e.preventDefault()
    try {
      await saveLicense({
        ...editing,
        price: editing.price === '' ? null : Number(editing.price),
        renewal_month: editing.renewal_month === '' ? null : Number(editing.renewal_month),
      })
      setEditing(null)
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleDeactivate(id) {
    try {
      await deactivateLicense(id)
      reload()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-4xl mx-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="font-display text-2xl font-bold text-brand">Admin — Catalog</h1>
          <button onClick={() => setEditing(BLANK)} className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2">
            + New license
          </button>
        </div>

        {error && <p className="text-sil-red mb-4">{error}</p>}

        <div className="bg-white rounded-xl shadow-sm divide-y">
          {licenses?.map(license => (
            <div key={license.id} className="p-4 flex items-center justify-between">
              <div>
                <p className={`font-medium ${license.active ? 'text-brand' : 'text-gray-400 line-through'}`}>{license.name}</p>
                <p className="text-xs text-gray-400">{license.vendor} · {license.category}</p>
              </div>
              <div className="flex gap-3">
                <button onClick={() => setEditing(license)} className="text-xs font-medium text-brand">Edit</button>
                {license.active && (
                  <button onClick={() => handleDeactivate(license.id)} className="text-xs font-medium text-sil-red">Deactivate</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 overflow-y-auto">
          <form onSubmit={handleSave} className="bg-white rounded-2xl shadow-lg p-8 max-w-lg w-full space-y-3 my-8">
            <h2 className="font-display text-xl font-bold text-brand mb-2">{editing.id ? 'Edit license' : 'New license'}</h2>

            <Field label="Name" value={editing.name} onChange={v => setEditing({ ...editing, name: v })} required />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Vendor" value={editing.vendor} onChange={v => setEditing({ ...editing, vendor: v })} />
              <Field label="Category" value={editing.category} onChange={v => setEditing({ ...editing, category: v })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Price" type="number" value={editing.price} onChange={v => setEditing({ ...editing, price: v })} />
              <Field label="Price unit" value={editing.price_unit} onChange={v => setEditing({ ...editing, price_unit: v })} placeholder="per seat/year" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-sm text-gray-700">
                Billing cycle
                <select value={editing.billing_cycle}
                  onChange={e => setEditing({
                    ...editing, billing_cycle: e.target.value,
                    ...(e.target.value === 'one_time' ? { renewal_month: '', renewal_reminder: false } : {}),
                  })}
                  className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm">
                  <option value="annual">Annual</option>
                  <option value="monthly">Monthly</option>
                  <option value="one_time">One-time (not recurring)</option>
                </select>
              </label>
              {editing.billing_cycle !== 'one_time' && (
                <Field label="Renewal month (1-12)" type="number" value={editing.renewal_month} onChange={v => setEditing({ ...editing, renewal_month: v })} />
              )}
            </div>
            <Field label="Activation URL" value={editing.activation_url} onChange={v => setEditing({ ...editing, activation_url: v })}
              hint="Set this if activation needs manual admin/service-manager provisioning after approval." />
            <Field label="More info URL" value={editing.more_info_url} onChange={v => setEditing({ ...editing, more_info_url: v })} />
            <Field label="Logo URL" value={editing.logo_url} onChange={v => setEditing({ ...editing, logo_url: v })} />
            <Field label="Google Group email" value={editing.google_group_email} onChange={v => setEditing({ ...editing, google_group_email: v })}
              hint="Not automated yet — see supabase/schema_licenses.sql notes." />
            <Field label="Service manager email" value={editing.service_manager_email} onChange={v => setEditing({ ...editing, service_manager_email: v })} />

            <div className="flex gap-4 text-sm pt-1">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={editing.gtis_sponsored} onChange={e => setEditing({ ...editing, gtis_sponsored: e.target.checked })} />
                GTIS-sponsored (no approval needed)
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={editing.pro_rated} onChange={e => setEditing({ ...editing, pro_rated: e.target.checked })} />
                Pro-rated
              </label>
            </div>

            <div className="flex gap-3 pt-3">
              <button type="submit" className="text-sm font-medium bg-brand text-white rounded-lg px-4 py-2">Save</button>
              <button type="button" onClick={() => setEditing(null)} className="text-sm font-medium text-gray-500">Cancel</button>
            </div>
          </form>
        </div>
      )}
    </AppLayout>
  )
}

function Field({ label, value, onChange, type = 'text', required, placeholder, hint }) {
  return (
    <label className="block text-sm text-gray-700">
      {label}
      <input
        type={type}
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        required={required}
        placeholder={placeholder}
        className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
      />
      {hint && <span className="block text-xs text-gray-400 mt-0.5">{hint}</span>}
    </label>
  )
}

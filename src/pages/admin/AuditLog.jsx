import { useEffect, useState } from 'react'
import AppLayout from '../../components/AppLayout'
import { getLinks } from '../../navLinks'
import { getAuditLog } from '../../lib/admin'

export default function AdminAuditLog() {
  const [entries, setEntries] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    getAuditLog().then(setEntries).catch(e => setError(e.message))
  }, [])

  return (
    <AppLayout appName="License Manager" links={getLinks()}>
      <div className="max-w-5xl mx-auto p-6">
        <h1 className="font-display text-2xl font-bold text-brand mb-6">Admin — Audit Log</h1>
        {error && <p className="text-sil-red mb-4">{error}</p>}

        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-gray-400 border-b">
              <tr>
                <th className="p-3">When</th>
                <th className="p-3">Action</th>
                <th className="p-3">License</th>
                <th className="p-3">User</th>
                <th className="p-3">Suite Key</th>
                <th className="p-3">By</th>
                <th className="p-3">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {entries?.map(entry => (
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
      </div>
    </AppLayout>
  )
}

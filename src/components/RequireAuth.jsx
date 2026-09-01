import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

// allowServiceManager: lets a license's service manager through a role="admin"
// gate too, on top of the usual admin bypass — for pages admins share with
// service managers (e.g. /admin/all-subscriptions). Checked via
// is_service_manager_any() (supabase/schema_licenses.sql), a plain "does the
// caller service-manage at least one license" question — the page itself is
// still responsible for only showing/allowing what RLS actually grants a
// non-admin caller.
export default function RequireAuth({ children, role, allowServiceManager }) {
  const { session, profile, loading, authError, refreshProfile } = useAuth()
  const [isServiceManager, setIsServiceManager] = useState(null)

  useEffect(() => {
    if (!allowServiceManager || !session) return
    supabase.rpc('is_service_manager_any').then(({ data }) => setIsServiceManager(!!data))
  }, [allowServiceManager, session])

  if (loading) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>
  if (!session) return <Navigate to="/" replace />
  if (role && !profile && authError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center text-center px-4">
        <p className="text-gray-600 mb-4 max-w-sm">
          We couldn't load your profile. If your browser blocked a redirect, allow redirects for
          sil.org and accounts.google.com, then try again.
        </p>
        <button onClick={refreshProfile} className="text-brand underline text-sm">Try again</button>
      </div>
    )
  }
  if (role && profile?.role !== role && profile?.role !== 'admin') {
    if (!allowServiceManager || isServiceManager === null) {
      return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>
    }
    if (!isServiceManager) return <Navigate to="/dashboard" replace />
  }

  return children
}

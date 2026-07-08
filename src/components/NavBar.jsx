import { Link, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { signOut } from '../lib/auth'

const LINKS = [
  { to: '/catalog', label: 'Catalog' },
  { to: '/subscriptions', label: 'My Subscriptions' },
  { to: '/approvals', label: 'Approvals' },
]

export default function NavBar() {
  const { profile } = useAuth()
  const { pathname } = useLocation()

  return (
    <nav className="bg-brand text-white">
      <div className="max-w-5xl mx-auto px-6 py-3 flex items-center gap-6">
        <img src="/sil-logo.png" alt="SIL" className="h-6" />
        <span className="font-display font-bold text-lg mr-4">License Manager</span>

        {LINKS.map(link => (
          <Link
            key={link.to}
            to={link.to}
            className={`text-sm font-medium ${pathname.startsWith(link.to) ? 'text-white' : 'text-white/70 hover:text-white'}`}
          >
            {link.label}
          </Link>
        ))}

        {profile?.role === 'admin' && (
          <>
            <Link
              to="/admin/catalog"
              className={`text-sm font-medium ${pathname === '/admin/catalog' ? 'text-white' : 'text-white/70 hover:text-white'}`}
            >
              Admin
            </Link>
            <Link
              to="/admin/audit-log"
              className={`text-sm font-medium ${pathname === '/admin/audit-log' ? 'text-white' : 'text-white/70 hover:text-white'}`}
            >
              Audit Log
            </Link>
          </>
        )}

        <button onClick={signOut} className="ml-auto text-sm font-medium text-white/70 hover:text-white">
          Sign out
        </button>
      </div>
    </nav>
  )
}

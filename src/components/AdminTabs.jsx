import { Link, useLocation } from 'react-router-dom'

// Horizontal subnav for Admin pages, matching the GAS original's layout —
// less mouse travel than the sidebar's nested submenu, since switching
// between admin views is a same-row click instead of reopening a dropdown.
const TABS = [
  { to: '/admin/catalog', label: 'Catalog' },
  { to: '/admin/all-subscriptions', label: 'All Subscriptions' },
  { to: '/admin/audit-log', label: 'Audit Log' },
  { to: '/admin/finance-export', label: 'Finance Export' },
  { to: '/admin/suite-keys', label: 'SuiteKeys' },
  { to: '/admin/ministry-ids', label: 'Ministry IDs' },
  { to: '/admin/import', label: 'Import' },
  { to: '/admin/users', label: 'Admin Users' },
  { to: '/admin/announcements', label: 'Announcement' },
]

// Rendered as the first child inside each admin page's `max-w-6xl mx-auto
// p-6` wrapper — every admin page shares that same width specifically so
// this always has room for all 9 tabs without scrolling; don't put this
// inside a narrower wrapper again without rechecking that.
//
// Deliberately NOT overflow-x-auto: per the CSS Overflow spec, setting
// overflow-x to anything but visible forces the other axis's *used* value
// to auto too, even if overflow-y is explicitly set to visible — so it
// silently created a vertical scrollbar on this box with nothing to
// scroll to. Since every admin page is wide enough for all 8 tabs, there's
// no horizontal overflow to defend against in the first place.
export default function AdminTabs() {
  const { pathname } = useLocation()
  return (
    <div className="border-b border-gray-200 mb-6 pt-1">
      <nav className="flex gap-6 w-max">
        {TABS.map(tab => (
          <Link
            key={tab.to}
            to={tab.to}
            className={`py-3.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors
              ${pathname === tab.to
                ? 'border-brand text-brand'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </div>
  )
}

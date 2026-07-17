import { FileText, LayoutGrid, ShieldCheck, Users, KeyRound, Settings, HelpCircle } from 'lucide-react'

// Catalog's children are data-driven (the distinct categories currently in
// the catalog), so this is a function, not a static array — call it with
// whatever categories the current page has loaded (most pages don't have
// them loaded and can omit the argument).
export function getLinks({ categories = [] } = {}) {
  return [
    { to: '/subscriptions', label: 'My Subscriptions', icon: FileText },
    {
      to: '/catalog', label: 'Catalog', icon: LayoutGrid,
      children: categories.map(c => ({ to: `/catalog?category=${encodeURIComponent(c)}`, label: c })),
    },
    { to: '/approvals', label: 'Approvals', icon: ShieldCheck },
    { to: '/my-team', label: 'My Team', icon: Users },
    { to: '/suite-key-charges', label: 'SuiteKey Charges', icon: KeyRound },
    { to: '/faq', label: 'FAQ', icon: HelpCircle },
    // A single direct link now, not an expandable submenu — switching between
    // admin views happens via the horizontal AdminTabs bar each admin page
    // renders instead, matching GAS's layout (less mouse travel than
    // reopening a sidebar dropdown for every switch).
    { to: '/admin/catalog', label: 'Admin', icon: Settings, adminOnly: true },
  ]
}

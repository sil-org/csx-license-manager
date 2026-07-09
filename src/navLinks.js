import { FileText, LayoutGrid, ShieldCheck, Settings, HelpCircle } from 'lucide-react'

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
    { to: '/faq', label: 'FAQ', icon: HelpCircle },
    {
      label: 'Admin', icon: Settings, adminOnly: true,
      children: [
        { to: '/admin/catalog', label: 'Catalog' },
        { to: '/admin/audit-log', label: 'Audit Log' },
        // Suite Keys / Ministry IDs admin pages don't exist yet — add here once built.
      ],
    },
  ]
}

import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import AuthCallback from './pages/AuthCallback'
import Catalog from './pages/Catalog'
import MySubscriptions from './pages/MySubscriptions'
import ActionCenter from './pages/ActionCenter'
import MyTeam from './pages/MyTeam'
import SuiteKeyCharges from './pages/SuiteKeyCharges'
import FAQ from './pages/FAQ'
import AdminCatalog from './pages/admin/Catalog'
import AdminAllSubscriptions from './pages/admin/AllSubscriptions'
import AdminAuditLog from './pages/admin/AuditLog'
import AdminFinanceExport from './pages/admin/FinanceExport'
import AdminSuiteKeys from './pages/admin/SuiteKeys'
import AdminMinistryIds from './pages/admin/MinistryIds'
import AdminImport from './pages/admin/Import'
import AdminUsers from './pages/admin/AdminUsers'
import RequireAuth from './components/RequireAuth'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/auth/callback" element={<AuthCallback />} />

      <Route path="/catalog" element={
        <RequireAuth><Catalog /></RequireAuth>
      } />

      <Route path="/subscriptions" element={
        <RequireAuth><MySubscriptions /></RequireAuth>
      } />

      {/* Not role-gated: any signed-in user can view it, but it's only ever
          non-empty for SuiteKey owners / service managers (see RLS in
          supabase/schema_licenses.sql). */}
      <Route path="/action-center" element={
        <RequireAuth><ActionCenter /></RequireAuth>
      } />

      {/* Not role-gated — same convention as /action-center: empty unless the
          signed-in user has direct/indirect reports (profiles.manager_email). */}
      <Route path="/my-team" element={
        <RequireAuth><MyTeam /></RequireAuth>
      } />

      {/* Not role-gated — empty unless you own at least one SuiteKey. */}
      <Route path="/suite-key-charges" element={
        <RequireAuth><SuiteKeyCharges /></RequireAuth>
      } />

      <Route path="/faq" element={
        <RequireAuth><FAQ /></RequireAuth>
      } />

      <Route path="/admin/catalog" element={
        <RequireAuth role="admin"><AdminCatalog /></RequireAuth>
      } />

      {/* allowServiceManager: also open to a license's service manager, not
          just admins — they need this page for provisioning/cancelling their
          own licenses' subscriptions. RLS scopes what a non-admin actually
          sees/can act on here to their own rows. */}
      <Route path="/admin/all-subscriptions" element={
        <RequireAuth role="admin" allowServiceManager><AdminAllSubscriptions /></RequireAuth>
      } />

      <Route path="/admin/audit-log" element={
        <RequireAuth role="admin"><AdminAuditLog /></RequireAuth>
      } />

      <Route path="/admin/finance-export" element={
        <RequireAuth role="admin"><AdminFinanceExport /></RequireAuth>
      } />

      <Route path="/admin/suite-keys" element={
        <RequireAuth role="admin"><AdminSuiteKeys /></RequireAuth>
      } />

      <Route path="/admin/ministry-ids" element={
        <RequireAuth role="admin"><AdminMinistryIds /></RequireAuth>
      } />

      <Route path="/admin/import" element={
        <RequireAuth role="admin"><AdminImport /></RequireAuth>
      } />

      <Route path="/admin/users" element={
        <RequireAuth role="admin"><AdminUsers /></RequireAuth>
      } />
    </Routes>
  )
}

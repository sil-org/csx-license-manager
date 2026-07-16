import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import AuthCallback from './pages/AuthCallback'
import Catalog from './pages/Catalog'
import MySubscriptions from './pages/MySubscriptions'
import Approvals from './pages/Approvals'
import MyTeam from './pages/MyTeam'
import SuiteKeyCharges from './pages/SuiteKeyCharges'
import FAQ from './pages/FAQ'
import AdminCatalog from './pages/admin/Catalog'
import AdminAuditLog from './pages/admin/AuditLog'
import AdminSuiteKeys from './pages/admin/SuiteKeys'
import AdminMinistryIds from './pages/admin/MinistryIds'
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
      <Route path="/approvals" element={
        <RequireAuth><Approvals /></RequireAuth>
      } />

      {/* Not role-gated — same convention as /approvals: empty unless the
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

      <Route path="/admin/audit-log" element={
        <RequireAuth role="admin"><AdminAuditLog /></RequireAuth>
      } />

      <Route path="/admin/suite-keys" element={
        <RequireAuth role="admin"><AdminSuiteKeys /></RequireAuth>
      } />

      <Route path="/admin/ministry-ids" element={
        <RequireAuth role="admin"><AdminMinistryIds /></RequireAuth>
      } />
    </Routes>
  )
}

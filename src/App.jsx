import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import AuthCallback from './pages/AuthCallback'
import Catalog from './pages/Catalog'
import MySubscriptions from './pages/MySubscriptions'
import Approvals from './pages/Approvals'
import FAQ from './pages/FAQ'
import AdminCatalog from './pages/admin/Catalog'
import AdminAuditLog from './pages/admin/AuditLog'
import AdminSuiteKeys from './pages/admin/SuiteKeys'
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
          non-empty for Suite Key owners / service managers (see RLS in
          supabase/schema_licenses.sql). */}
      <Route path="/approvals" element={
        <RequireAuth><Approvals /></RequireAuth>
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
    </Routes>
  )
}

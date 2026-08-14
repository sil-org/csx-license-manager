import { supabase } from './supabase'

export async function getActiveLicenses() {
  const { data, error } = await supabase
    .from('licenses')
    .select('*')
    .eq('active', true)
    .order('name')
  if (error) throw error
  return data
}

// Admin/service-manager view — includes inactive licenses too.
export async function getAllLicenses() {
  const { data, error } = await supabase
    .from('licenses')
    .select('*')
    .order('name')
  if (error) throw error
  return data
}

export async function saveLicense(license) {
  const { data, error } = await supabase.rpc('save_license', { p_license: license })
  if (error) throw error
  return data
}

export async function deactivateLicense(licenseId) {
  const { error } = await supabase.rpc('deactivate_license', { p_license_id: licenseId })
  if (error) throw error
}

export async function reactivateLicense(licenseId) {
  const { error } = await supabase.rpc('reactivate_license', { p_license_id: licenseId })
  if (error) throw error
}

// CRUD for a department-gated license's opt-in approval list (sco -> approver
// email) — see request_subscription()'s department_gated branch in
// supabase/pending/40_department_gated_licenses.sql.
export async function listDepartmentApprovals(licenseId) {
  const { data, error } = await supabase.rpc('admin_list_department_approvals', { p_license_id: licenseId })
  if (error) throw error
  return data || []
}

export async function addDepartmentApproval(licenseId, sco, approverEmail) {
  const { error } = await supabase.rpc('admin_add_department_approval', {
    p_license_id: licenseId, p_sco: sco, p_approver_email: approverEmail,
  })
  if (error) throw error
}

export async function removeDepartmentApproval(id) {
  const { error } = await supabase.rpc('admin_remove_department_approval', { p_id: id })
  if (error) throw error
}

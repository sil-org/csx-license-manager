import { supabase } from './supabase'

// Sorts names like "Shared Drive Quota - 100 GB" / "... - 1 TB" by actual
// size instead of lexicographically (which would put "100" before "50", and
// "1 TB" before both since space sorts before any digit).
// Names without a size pattern just fall back to plain alphabetical order.
const SIZE_RE = /(\d+(?:\.\d+)?)\s*(g|gb|t|tb)\b/i
const UNIT_GB = { g: 1, gb: 1, t: 1000, tb: 1000 }

export function sizeAwareSort(name) {
  const m = name.match(SIZE_RE)
  if (!m) return name.toLowerCase()
  const size = parseFloat(m[1]) * UNIT_GB[m[2].toLowerCase()]
  return String(size).padStart(10, '0') + name.toLowerCase()
}

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

// CRUD for a license's area-level discounts (area -> discount_percent off
// catalog price) — see get_area_discounted_price() in
// supabase/pending/73_area_pricing.sql.
export async function listAreaDiscounts(licenseId) {
  const { data, error } = await supabase.rpc('admin_list_area_discounts', { p_license_id: licenseId })
  if (error) throw error
  return data || []
}

export async function addAreaDiscount(licenseId, area, discountPercent) {
  const { error } = await supabase.rpc('admin_add_area_discount', {
    p_license_id: licenseId, p_area: area, p_discount_percent: discountPercent,
  })
  if (error) throw error
}

export async function removeAreaDiscount(id) {
  const { error } = await supabase.rpc('admin_remove_area_discount', { p_id: id })
  if (error) throw error
}

// Distinct known areas (from sco_codes, imported from Kate's org-structure
// Sheet) — populates the area dropdown in the admin UI.
export async function listAreas() {
  const { data, error } = await supabase.rpc('admin_list_areas')
  if (error) throw error
  return (data || []).map(r => r.area)
}

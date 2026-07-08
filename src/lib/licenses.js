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

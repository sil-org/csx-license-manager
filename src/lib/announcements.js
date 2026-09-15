import { supabase } from './supabase'

// Public read: RLS only exposes this row when enabled=true (or to an
// admin), so a non-admin gets null once the banner is turned off.
export async function getActiveAnnouncement() {
  const { data, error } = await supabase
    .from('announcements')
    .select('id, message, cta_label, cta_url, updated_at')
    .eq('enabled', true)
    .maybeSingle()
  if (error) throw error
  return data
}

// Admin form load — RLS lets an admin read the row regardless of enabled,
// so no RPC needed for the read side (only the write goes through the RPC).
export async function getAnnouncement() {
  const { data, error } = await supabase
    .from('announcements')
    .select('*')
    .maybeSingle()
  if (error) throw error
  return data
}

export async function saveAnnouncement({ message, ctaLabel, ctaUrl, enabled }) {
  const { error } = await supabase.rpc('admin_save_announcement', {
    p_message: message,
    p_cta_label: ctaLabel || null,
    p_cta_url: ctaUrl || null,
    p_enabled: enabled,
  })
  if (error) throw error
}

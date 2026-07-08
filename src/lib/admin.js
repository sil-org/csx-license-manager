import { supabase } from './supabase'

export async function getAuditLog({ suiteKey, limit = 200 } = {}) {
  let query = supabase
    .from('audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (suiteKey) query = query.eq('suite_key', suiteKey)

  const { data, error } = await query
  if (error) throw error
  return data
}

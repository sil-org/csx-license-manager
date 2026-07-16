import { supabase } from './supabase'

// Mirrors Managers.gs's getAllSuiteKeyCharges(): every non-cancelled
// subscription charged to any SuiteKey the current user owns, across all
// owned keys at once. Uses get_my_suite_keys() rather than a plain select on
// suite_keys — that table's RLS policy returns *every* row to an admin
// (correct for RLS's purposes), which would wrongly make this page think an
// admin owns every SuiteKey in the system.
export async function getMySuiteKeyCharges() {
  const { data: owned, error: ownedError } = await supabase.rpc('get_my_suite_keys')
  if (ownedError) throw ownedError
  if (!owned?.length) return { charges: [], ownedKeys: [] }

  const ownedKeys = owned.map(k => (typeof k === 'string' ? k : k.get_my_suite_keys))
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*, license:licenses(name, vendor, category)')
    .in('suite_key', ownedKeys)
    .neq('status', 'cancelled')
    .order('suite_key')
  if (error) throw error
  return { charges: data, ownedKeys }
}

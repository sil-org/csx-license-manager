import { supabase } from './supabase'

// Typeahead for the Catalog request form — mirrors GAS's searchSuiteKeys().
// Unlike admin.js's getSuiteKeys(), this has to work for any requester, not
// just admins, so it goes through the search_suite_keys() RPC rather than a
// plain select (suite_keys' RLS policy only lets a regular user read keys
// they own). Never returns owner_email/owner_group_email — just whether a
// key already has an owner — so the search box can't be used to harvest
// other people's email addresses.
export async function searchSuiteKeys(query) {
  if (!query?.trim()) return []
  const { data, error } = await supabase.rpc('search_suite_keys', { p_query: query })
  if (error) throw error
  return data || []
}

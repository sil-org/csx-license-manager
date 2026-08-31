import { createClient } from 'jsr:@supabase/supabase-js@2'
import { cubebackupSync } from './adapters/cubebackup.ts'
import { addGroupMember, removeGroupMember } from './adapters/google-group.ts'

// Two independent things live in this one function:
//
// 1. CubeBackup (and any future licenses.provisioning_adapter) dispatch —
//    reconciles active subscriptions against the vendor's actual roster.
//    Same model as sync-group-memberships: recompute desired state from the
//    DB and diff against the vendor's actual roster, rather than reacting to
//    each individual activate/cancel/revoke — the reconciler doesn't care
//    *how* a subscription stopped being active, only that it now isn't.
//    That's what lets every future vendor integration be "write one adapter
//    + set a column" instead of a bespoke Postgres trigger + Edge Function
//    per vendor. Runs whenever this function is invoked with no body (the
//    scheduled trigger, or any fire-and-forget kick that doesn't pass one).
//
// 2. Google Group single-member update — pass { groupMembershipUpdate:
//    { licenseId, email, action: 'add' | 'remove' } } in the request body to
//    add or remove exactly that one person from that one license's
//    google_group_email, and nothing else runs. Deliberately NOT a
//    reconciliation like #1 — see adapters/google-group.ts's header comment
//    for why: a diff-based "recompute desired membership, delete anyone not
//    in it" reconciler was tried first and, on 2026-08-28, deleted years of
//    real members from config_quota_100gb@groups.sil.org because this app's
//    `subscriptions` table was never a complete record of that group's real
//    membership. Touching only the one member named in the specific
//    activate/cancel event that triggered the call can't have that failure
//    mode — it never enumerates or deletes anyone else. Callers: see
//    handleActivate/handleCancel in src/pages/admin/AllSubscriptions.jsx and
//    the self-serve cancel in src/pages/MySubscriptions.jsx.
//
// Deployed WITH JWT verification on (no --no-verify-jwt) — unlike
// sync-group-memberships (cache-only writes, no request-auth check at all)
// or send-email (presence-only header check), this function makes real
// side-effecting calls to paid vendor APIs and Google's Directory API, so it
// needs the Supabase platform's real signature verification. Any
// authenticated caller can only trigger a correct dispatch of the DB's own
// truth (#1) or a targeted single-member update naming a real license/email
// (#2) — never an arbitrary write.
//
// Adapter contract (see adapters/cubebackup.ts):
//   async (config: object, desiredEmails: string[]) =>
//     { enabled: string[], disabled: string[], errors: {email, message}[] }
//
// Required secrets (Supabase Edge Function secrets):
//   CUBEBACKUP_API_KEY   CubeBackup server instance API key (scoped to the
//                        whole instance, not per-domain)
//   GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//                        for the google_group_email update (see
//                        adapters/google-group.ts) — same two secrets
//                        sync-group-memberships already uses.
//
// Scheduling: the CubeBackup dispatch (#1) isn't automated by this deploy —
// same posture as sync-group-memberships. See supabase/functions/README.md
// for how to wire up a schedule (Supabase Dashboard cron, or pg_cron +
// pg_net). The Google Group update (#2) is meant to be called directly from
// the frontend on each activate/cancel, not scheduled at all.

const ADAPTERS: Record<string, (config: any, desiredEmails: string[]) => Promise<SyncResult>> = {
  cubebackup: cubebackupSync,
}

interface SyncResult {
  enabled: string[]
  disabled: string[]
  errors: { email: string; message: string }[]
}

interface GroupMembershipUpdate {
  licenseId: string
  email: string
  action: 'add' | 'remove'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    let body: { groupMembershipUpdate?: GroupMembershipUpdate } = {}
    try { body = await req.json() } catch { /* no body — e.g. the scheduled CubeBackup trigger */ }

    if (body.groupMembershipUpdate) {
      return await handleGroupMembershipUpdate(supabase, body.groupMembershipUpdate)
    }

    const { data: licenses, error: licensesError } = await supabase
      .from('licenses')
      .select('id, name, provisioning_adapter, provisioning_config')
      .not('provisioning_adapter', 'is', null)
    if (licensesError) throw licensesError

    const summary = []

    // provisioning_adapter dispatch (CubeBackup etc.) — the Google Group
    // pass is handled entirely above via handleGroupMembershipUpdate and
    // never reaches this loop.
    for (const license of licenses || []) {
      const adapter = ADAPTERS[license.provisioning_adapter!]
      if (!adapter) {
        summary.push({ license: license.name, error: `Unknown adapter '${license.provisioning_adapter}'` })
        continue
      }

      // Atomic claim — skip if another run (e.g. a concurrent fire-and-forget
      // kick) already has this license locked. Real side-effecting vendor
      // calls happen below, unlike sync-group-memberships' cache-only writes,
      // so overlapping runs double-hitting the vendor's API is worth cheaply
      // preventing.
      const { data: claimed, error: claimError } = await supabase
        .from('licenses')
        .update({ provisioning_lock_until: new Date(Date.now() + 2 * 60_000).toISOString() })
        .eq('id', license.id)
        .or(`provisioning_lock_until.is.null,provisioning_lock_until.lt.${new Date().toISOString()}`)
        .select('id')
      if (claimError) throw claimError
      if (!claimed?.length) {
        summary.push({ license: license.name, skipped: 'locked by a concurrent run' })
        continue
      }

      try {
        const { data: subs, error: subsError } = await supabase
          .from('subscriptions')
          .select('user_email')
          .eq('license_id', license.id)
          .eq('status', 'active')
        if (subsError) throw subsError

        // Duplicate active rows for the same user+license aren't prevented at
        // the DB level (only within a single fiscal year) — distinct here is
        // load-bearing, not defensive.
        const desiredEmails = [...new Set((subs || []).map(s => s.user_email))]

        const result = await adapter(license.provisioning_config || {}, desiredEmails)

        const logRows = [
          ...result.enabled.map(email => ({ license_id: license.id, adapter: license.provisioning_adapter, email, action: 'enabled', status: 'ok' })),
          ...result.disabled.map(email => ({ license_id: license.id, adapter: license.provisioning_adapter, email, action: 'disabled', status: 'ok' })),
          ...result.errors.map(e => ({ license_id: license.id, adapter: license.provisioning_adapter, email: e.email, action: 'enabled', status: 'failed', error: e.message })),
        ]
        if (logRows.length) {
          const { error: logError } = await supabase.from('provisioning_log').insert(logRows)
          if (logError) throw logError
        }

        summary.push({ license: license.name, enabled: result.enabled.length, disabled: result.disabled.length, errors: result.errors.length })
      } catch (err) {
        console.error(`Provisioning sync failed for ${license.name}: ${err.message}`)
        summary.push({ license: license.name, error: err.message })
      }
    }

    return json({ ok: true, licensesProcessed: summary.length, summary })
  } catch (err) {
    console.error(err)
    return json({ error: err.message }, 500)
  }
})

// The Google Group half of this function — see the header comment for why
// this is a single targeted add/remove and never a full-membership diff.
async function handleGroupMembershipUpdate(
  supabase: ReturnType<typeof createClient>,
  update: GroupMembershipUpdate
): Promise<Response> {
  const { licenseId, email, action } = update

  const { data: license, error: licenseError } = await supabase
    .from('licenses')
    .select('id, name, google_group_email')
    .eq('id', licenseId)
    .single()
  if (licenseError) throw licenseError

  if (!license?.google_group_email) {
    return json({ ok: true, skipped: 'license has no google_group_email set' })
  }

  // On removal only: if this email still has a different active
  // subscription row for the same license (duplicates aren't prevented at
  // the DB level, only within a single fiscal year — see the dispatch loop
  // above), they still belong in the group. Don't kick them out because one
  // of their (possibly several) subscription rows was cancelled. No
  // equivalent check needed for 'add' — adding an existing member is just a
  // harmless 409, handled in adapters/google-group.ts.
  if (action === 'remove') {
    const { count, error: countError } = await supabase
      .from('subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('license_id', licenseId)
      .eq('user_email', email)
      .eq('status', 'active')
    if (countError) throw countError
    if ((count || 0) > 0) {
      return json({ ok: true, skipped: `${email} still has another active subscription to this license` })
    }
  }

  const logRow = { license_id: licenseId, adapter: 'google_group', email, action: action === 'add' ? 'enabled' : 'disabled', status: 'ok' }
  try {
    if (action === 'add') {
      await addGroupMember(license.google_group_email, email)
    } else {
      await removeGroupMember(license.google_group_email, email)
    }
    const { error: logError } = await supabase.from('provisioning_log').insert(logRow)
    if (logError) throw logError
    return json({ ok: true, license: license.name, email, action })
  } catch (err) {
    console.error(`Google Group ${action} failed for ${email} on ${license.name}: ${err.message}`)
    const { error: logError } = await supabase.from('provisioning_log').insert({ ...logRow, status: 'failed', error: err.message })
    if (logError) console.error(`Also failed to log the above error: ${logError.message}`)
    return json({ error: err.message }, 500)
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } })
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
}

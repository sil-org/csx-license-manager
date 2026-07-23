import { createClient } from 'jsr:@supabase/supabase-js@2'
import { cubebackupSync } from './adapters/cubebackup.ts'

// Reconciles active subscriptions against whatever external vendor system a
// license is configured to provision (licenses.provisioning_adapter). Same
// model as sync-group-memberships: recompute desired state from the DB and
// diff against the vendor's actual roster, rather than reacting to each
// individual activate/cancel/revoke — the reconciler doesn't care *how* a
// subscription stopped being active, only that it now isn't. That's what
// lets every future license integration be "write one adapter + set a
// column" instead of a bespoke Postgres trigger + Edge Function per vendor.
//
// Deployed WITH JWT verification on (no --no-verify-jwt) — unlike
// sync-group-memberships (cache-only writes, no request-auth check at all)
// or send-email (presence-only header check), this function makes real
// side-effecting calls to a paid vendor API, so it needs the Supabase
// platform's real signature verification. It takes no caller-supplied
// parameters — it only ever recomputes and applies the DB's own truth — so
// any authenticated caller (a signed-in user's own fire-and-forget kick, or
// the scheduled trigger passing the anon/service-role key) can only trigger
// a correct, idempotent reconciliation, never an arbitrary one.
//
// Adapter contract (see adapters/cubebackup.ts):
//   async (config: object, desiredEmails: string[]) =>
//     { enabled: string[], disabled: string[], errors: {email, message}[] }
//
// Required secrets (Supabase Edge Function secrets):
//   CUBEBACKUP_API_KEY   CubeBackup server instance API key (scoped to the
//                        whole instance, not per-domain)
//
// Scheduling: not automated by this deploy — same posture as
// sync-group-memberships. See supabase/functions/README.md for how to wire
// up a schedule (Supabase Dashboard cron, or pg_cron + pg_net).

const ADAPTERS: Record<string, (config: any, desiredEmails: string[]) => Promise<SyncResult>> = {
  cubebackup: cubebackupSync,
}

interface SyncResult {
  enabled: string[]
  disabled: string[]
  errors: { email: string; message: string }[]
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { data: licenses, error: licensesError } = await supabase
      .from('licenses')
      .select('id, name, provisioning_adapter, provisioning_config')
      .not('provisioning_adapter', 'is', null)
    if (licensesError) throw licensesError

    if (!licenses?.length) {
      return json({ ok: true, licensesProcessed: 0, message: 'No licenses currently have a provisioning_adapter set.' })
    }

    const summary = []

    for (const license of licenses) {
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

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(), 'Content-Type': 'application/json' } })
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
}

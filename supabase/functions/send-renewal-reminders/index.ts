import { createClient } from 'jsr:@supabase/supabase-js@2'

// Weekly renewal-reminder digest — one email per subscription owner, listing
// every annual subscription of theirs whose renewal date is coming up and
// who hasn't responded yet (renewal_status stays 'none' until they opt in or
// out via My Subscriptions). Mirrors gas-legacy/src/Emails.gs's
// sendPerLicenseReminders()/sendWeeklyReminders(), with two changes for the
// new app:
//   - CC's the original requester (per subscription) when different from the
//     owner — see issue #3 / src/lib/subscriptions.js's
//     buildRenewalReminderNotification(), which does the same resolution for
//     the manual single-subscription send in Admin -> All Subscriptions.
//   - No bearer-token opt-in/opt-out links (GAS emailed one-click URLs) —
//     the card just points to the authenticated /subscriptions page, same as
//     renewalReminderCardHtml() in src/lib/email.js. This function can't
//     import that module directly (it pulls in the browser Supabase client,
//     which reads Vite env vars that don't exist under Deno), so the HTML
//     below is a deliberate, minimal duplicate — keep the two in sync if the
//     design changes.
//
// Naturally idempotent per run: eligibility is recomputed from current DB
// state every time (status/renewal_status), so there's no separate "already
// reminded this week" tracking to maintain — same posture as sync-provisioning.
//
// Auth: checks its own CRON_SECRET rather than relying on Supabase's
// platform-level JWT verification (deployed with --no-verify-jwt, like
// send-email). That gate only understands legacy JWT-format anon/service_role
// keys — this project's client-facing key is the newer sb_publishable_...
// format (see .env), which the gate rejects outright, so it's the wrong tool
// for authorizing the pg_cron caller regardless. CRON_SECRET is set via
// `supabase secrets set` and the matching value is stored in Supabase Vault
// (`vault.decrypted_secrets`, name 'cron_secret') so the scheduling SQL in
// supabase/pending/ can reference it by name without a literal secret ever
// landing in a committed file.
const CRON_SECRET = Deno.env.get('CRON_SECRET')

const APP_ORIGIN = 'https://licensemanager.sil.org'
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
// ~2 months — matches the WINDOW constant gas-legacy/src/Emails.gs's
// sendPerLicenseReminders() actually used (that function's own header
// comment says "35 days", but the code itself computed 60).
const WINDOW_MS = 60 * 24 * 60 * 60 * 1000

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })
  if (!CRON_SECRET || req.headers.get('Authorization') !== `Bearer ${CRON_SECRET}`) {
    return json({ error: 'Unauthorized' }, 401)
  }

  // Optional { limit: n } body — caps how many owners' digests actually get
  // sent this run, for safely test-firing against production data (e.g. a
  // curl smoke test) without emailing every eligible owner at once. The
  // scheduled cron call sends no body, so limit is undefined and every
  // eligible owner gets their digest, same as always.
  const { limit } = await req.json().catch(() => ({ limit: undefined }))

  try {
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey)

    const { data: subs, error: subsError } = await supabase
      .from('subscriptions')
      .select('id, user_email, suite_key, ministry_id, billing_type, renewal_month, price_at_signup, license:licenses(name, reminder_message)')
      .eq('status', 'active')
      .eq('billing_cycle', 'annual')
      .eq('renewal_reminder', true)
      .eq('renewal_status', 'none')
      .neq('billing_type', 'gtis')
      .not('renewal_month', 'is', null)
    if (subsError) throw subsError

    const now = new Date()
    const eligible = (subs || []).filter(s => {
      const renewalDate = nextRenewalDate(s.renewal_month, now)
      return renewalDate.getTime() - now.getTime() <= WINDOW_MS
    })

    if (!eligible.length) {
      return json({ ok: true, emailsSent: 0, subscriptionsConsidered: 0 })
    }

    // Batched requester lookup (one query, not one per subscription) — same
    // audit_log 'requested'-action source as resendApprovalRequest()/
    // buildRenewalReminderNotification() in src/lib/subscriptions.js, picked
    // for the same reason: subscriptions.requested_by is a profiles uuid FK
    // that a plain SELECT can't safely resolve to an email from here anyway,
    // so staying consistent with the already-working lookup is simpler than
    // introducing a second way to answer "who requested this."
    const { data: auditRows, error: auditError } = await supabase
      .from('audit_log')
      .select('subscription_id, performed_by, created_at')
      .in('subscription_id', eligible.map(s => s.id))
      .eq('action', 'requested')
      .order('created_at', { ascending: false })
    if (auditError) throw auditError
    const requesterBySubId = new Map<string, string>()
    for (const row of auditRows || []) {
      if (!requesterBySubId.has(row.subscription_id)) requesterBySubId.set(row.subscription_id, row.performed_by)
    }

    // Grouped by lowercased email — user_email carries whatever case Google's
    // OAuth handed back at signup (see current_profile_email() in
    // schema_licenses.sql / commit 9ea3c0d), so comparing/keying on it
    // verbatim can silently split one person's digest across two "different"
    // owners over a pure case difference.
    const byOwner = new Map<string, { cardsHtml: string[]; cc: Set<string> }>()
    for (const sub of eligible) {
      const owner = sub.user_email.toLowerCase()
      if (!byOwner.has(owner)) byOwner.set(owner, { cardsHtml: [], cc: new Set() })
      const entry = byOwner.get(owner)!

      const renewalDate = nextRenewalDate(sub.renewal_month, now)
      const renewalLabel = `${MONTHS[renewalDate.getMonth()]} 1, ${renewalDate.getFullYear()}`
      const priceLabel = sub.price_at_signup != null ? `$${Number(sub.price_at_signup).toFixed(2)}/yr` : null
      const suiteKeyLabel = sub.billing_type === 'gtis' ? 'GTIS' : sub.billing_type === 'ministry' ? `Ministry ID ${sub.ministry_id}` : sub.suite_key

      entry.cardsHtml.push(renewalCardHtml({
        licenseName: sub.license?.name || 'License',
        suiteKey: suiteKeyLabel,
        priceLabel,
        renewalLabel,
        reminderMessage: sub.license?.reminder_message,
      }))

      const requester = requesterBySubId.get(sub.id)
      if (requester && requester.toLowerCase() !== owner) entry.cc.add(requester.toLowerCase())
    }

    const ownerEntries = typeof limit === 'number' ? [...byOwner].slice(0, limit) : [...byOwner]

    let emailsSent = 0
    const errors: { email: string; error: string }[] = []
    for (const [owner, { cardsHtml, cc }] of ownerEntries) {
      try {
        // Explicit Authorization header — supabase-js's implicit default
        // (from the key passed to createClient) doesn't reliably reach
        // send-email on a function-to-function invoke, and send-email 401s
        // without it (it only checks that *some* Authorization header is
        // present, but "some" still has to actually arrive).
        const { error } = await supabase.functions.invoke('send-email', {
          headers: { Authorization: `Bearer ${serviceRoleKey}` },
          body: {
            to: owner,
            cc: cc.size ? [...cc] : undefined,
            subject: 'Action Required: Software License Renewal',
            html: renewalDigestHtml(cardsHtml.join('')),
            template: 'renewal_reminder',
          },
        })
        if (error) throw error
        emailsSent++
      } catch (err) {
        // FunctionsHttpError's real payload is on err.context (the raw
        // Response) — err.message alone is just supabase-js's generic
        // "Edge Function returned a non-2xx status code", which hides
        // whatever send-email actually said.
        const detail = err.context ? await err.context.text().catch(() => null) : null
        console.error(`renewal reminder failed for ${owner}: ${err.message}${detail ? ` — ${detail}` : ''}`)
        errors.push({ email: owner, error: detail || err.message })
      }
    }

    return json({ ok: true, emailsSent, subscriptionsConsidered: eligible.length, errors })
  } catch (err) {
    console.error(err)
    return json({ error: err.message }, 500)
  }
})

function nextRenewalDate(renewalMonth: number, now: Date): Date {
  let date = new Date(now.getFullYear(), renewalMonth - 1, 1)
  if (date.getTime() <= now.getTime()) date = new Date(now.getFullYear() + 1, renewalMonth - 1, 1)
  return date
}

function renewalCardHtml({ licenseName, suiteKey, priceLabel, renewalLabel, reminderMessage }: {
  licenseName: string; suiteKey: string | null; priceLabel: string | null; renewalLabel: string; reminderMessage?: string | null
}) {
  const intro = reminderMessage || `Your <strong>${licenseName}</strong> subscription is coming up for renewal.`
  return `
    <div style="border:1px solid #e0e0e0;border-radius:8px;padding:16px;margin:12px 0">
      <div style="font-weight:600;font-size:15px;color:#202124">${licenseName}</div>
      <p style="margin:8px 0;font-size:14px">${intro}</p>
      <div style="color:#666666;font-size:13px;margin:4px 0 12px">
        SuiteKey: ${suiteKey}${renewalLabel ? ` • Renews ${renewalLabel}` : ''}${priceLabel ? ` • ${priceLabel}` : ''}
      </div>
      <div style="margin:20px 0">
        <a href="${APP_ORIGIN}/subscriptions" style="background:#1e8e3e;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;margin:4px 10px 4px 0;font-size:14px">✓ Yes, Renew</a>
        <a href="${APP_ORIGIN}/subscriptions" style="background:#D52227;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;margin:4px 10px 4px 0;font-size:14px">✗ No, Don't Renew</a>
      </div>
    </div>`
}

function renewalDigestHtml(cardsHtml: string) {
  return `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #202124;">
  <h2 style="color: #005CB9; margin: 0 0 16px; font-size: 20px;">Software License Renewal Reminder</h2>
  <p>The following annual licenses are coming up for renewal. Please indicate whether you'd like to continue each subscription:</p>
  ${cardsHtml}
  <p style="color:#666666;font-size:13px;margin-top:24px">
    You'll receive weekly reminders until you respond for each license. Once you reply, no further
    reminders will be sent for that subscription. Questions? Contact the License Manager team.
  </p>
  <p style="color: #666666; font-size: 12px; margin-top: 24px;">
    Respond any time from <a href="${APP_ORIGIN}/subscriptions" style="color: #005CB9;">License Manager → My Subscriptions</a>.
  </p>
</div>`
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

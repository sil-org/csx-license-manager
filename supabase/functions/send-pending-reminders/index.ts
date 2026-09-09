import { createClient } from 'jsr:@supabase/supabase-js@2'

// Weekly digest reminding people about outstanding pending requests they
// haven't acted on yet — mirrors gas-legacy/src/Emails.gs's
// sendPendingReminders(), which covers two independent groups:
//   1. SuiteKey ownership confirmations (status = pending_sk_verification) —
//      one email per suggested approver (subscriptions.pending_approver_email),
//      listing every SuiteKey awaiting their yes/no.
//   2. License approvals (status = pending) — one email per SuiteKey owner
//      (suite_keys.owner_email / owner_group_email), listing every request
//      waiting on their approve/decline.
//
// Unlike GAS, there are no bearer-token one-click action links — every row
// just points to the authenticated /action-center page, same as
// skVerificationEmailHtml/approvalRequestEmailHtml in src/lib/email.js. This
// function can't import that module directly (it pulls in the browser
// Supabase client, which reads Vite env vars that don't exist under Deno),
// so the HTML below is a deliberate, minimal duplicate of that visual style
// — keep the two in sync if the design changes.
//
// Naturally idempotent per run: both groups are recomputed from current
// status every time, so there's no "already reminded" state to track — same
// posture as send-renewal-reminders/sync-provisioning.
//
// Auth: checks its own CRON_SECRET rather than relying on Supabase's
// platform-level JWT verification (deployed with --no-verify-jwt, like
// send-email) — see send-renewal-reminders/index.ts's header comment for why
// (this project's client-facing key is the newer sb_publishable_... format,
// which that gate can't validate at all).
const CRON_SECRET = Deno.env.get('CRON_SECRET')

const APP_ORIGIN = 'https://licensemanager.sil.org'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })
  if (!CRON_SECRET || req.headers.get('Authorization') !== `Bearer ${CRON_SECRET}`) {
    return json({ error: 'Unauthorized' }, 401)
  }

  // Optional { limit: n } body — caps how many recipients each group
  // actually gets sent to this run, for safely test-firing against
  // production data without emailing every approver/owner at once. The
  // scheduled cron call sends no body, so limit is undefined and everyone
  // eligible gets reminded, same as always.
  const { limit } = await req.json().catch(() => ({ limit: undefined }))

  try {
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey)

    const [verificationResult, approvalResult] = await Promise.all([
      sendVerificationReminders(supabase, serviceRoleKey, limit),
      sendApprovalReminders(supabase, serviceRoleKey, limit),
    ])

    return json({
      ok: true,
      emailsSent: verificationResult.emailsSent + approvalResult.emailsSent,
      verification: verificationResult,
      approval: approvalResult,
    })
  } catch (err) {
    console.error(err)
    return json({ error: err.message }, 500)
  }
})

async function sendVerificationReminders(supabase: any, serviceRoleKey: string, limit?: number) {
  const { data: subs, error } = await supabase
    .from('subscriptions')
    .select('id, suite_key, pending_approver_email, license:licenses(name, price, price_unit)')
    .eq('status', 'pending_sk_verification')
    .not('pending_approver_email', 'is', null)
  if (error) throw error

  // Group by approver, then by SuiteKey — one row (and one action link) per
  // SuiteKey even if multiple people requested against the same unverified
  // key, mirroring GAS's bySK grouping.
  const byApprover = new Map<string, Map<string, { licenseName: string; price: number | string | null; priceUnit: string | null }>>()
  for (const sub of subs || []) {
    const approver = sub.pending_approver_email!.toLowerCase()
    if (!byApprover.has(approver)) byApprover.set(approver, new Map())
    byApprover.get(approver)!.set(sub.suite_key, {
      licenseName: sub.license?.name || 'License',
      price: sub.license?.price ?? null,
      priceUnit: sub.license?.price_unit ?? null,
    })
  }

  const approverEntries = typeof limit === 'number' ? [...byApprover].slice(0, limit) : [...byApprover]

  let emailsSent = 0
  const errors: { email: string; error: string }[] = []
  for (const [approver, bySK] of approverEntries) {
    try {
      const rowsHtml = [...bySK.entries()].map(([suiteKey, { licenseName, price, priceUnit }]) => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0"><strong>${suiteKey}</strong></td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0">${licenseName}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0">${priceLabel(price, priceUnit)}</td>
        </tr>`).join('')
      const count = bySK.size

      // Explicit Authorization header — see send-renewal-reminders/index.ts's
      // comment on the same pattern (the implicit client default doesn't
      // reliably reach send-email on a function-to-function invoke).
      const { error: sendError } = await supabase.functions.invoke('send-email', {
        headers: { Authorization: `Bearer ${serviceRoleKey}` },
        body: {
          to: approver,
          subject: `Reminder: ${count} SuiteKey ownership confirmation${count === 1 ? '' : 's'} awaiting your response`,
          html: pendingDigestHtml({
            heading: 'License Manager — Action Required',
            intro: `Do you manage the following SuiteKey${count === 1 ? '' : 's'}? Please confirm or deny so the associated license request${count === 1 ? ' can' : 's can'} proceed.`,
            columns: ['SuiteKey', 'License', 'Cost'],
            rowsHtml,
          }),
          template: 'sk_verification_reminder',
        },
      })
      if (sendError) throw sendError
      emailsSent++
    } catch (err) {
      const detail = err.context ? await err.context.text().catch(() => null) : null
      console.error(`verification reminder failed for ${approver}: ${err.message}${detail ? ` — ${detail}` : ''}`)
      errors.push({ email: approver, error: detail || err.message })
    }
  }
  return { emailsSent, approversNotified: byApprover.size, errors }
}

async function sendApprovalReminders(supabase: any, serviceRoleKey: string, limit?: number) {
  const { data: subs, error } = await supabase
    .from('subscriptions')
    .select('id, user_email, suite_key, license:licenses(name, price, price_unit)')
    .eq('status', 'pending')
    .not('suite_key', 'is', null)
  if (error) throw error

  const suiteKeys = [...new Set((subs || []).map((s: any) => s.suite_key))]
  // Lowercased — suite_keys.owner_email isn't guaranteed lowercase
  // (confirm_sk_ownership() in schema_licenses.sql stores current_profile_email()
  // verbatim, same root cause as commit 9ea3c0d's fix elsewhere, just not
  // patched at that call site). Without this, one real owner whose keys
  // picked up different casing across confirmations would get split into
  // two separate reminder emails instead of one combined digest.
  const ownerBySK = new Map<string, string>()
  if (suiteKeys.length) {
    const { data: keyRows, error: keysError } = await supabase
      .from('suite_keys')
      .select('suite_key, owner_email, owner_group_email')
      .in('suite_key', suiteKeys)
    if (keysError) throw keysError
    for (const k of keyRows || []) {
      const owner = (k.owner_group_email || k.owner_email)?.toLowerCase()
      if (owner) ownerBySK.set(k.suite_key, owner)
    }
  }

  // Same audit_log 'requested'-action lookup as send-renewal-reminders/
  // src/lib/subscriptions.js's resendApprovalRequest() — the established way
  // to answer "who requested this" without relying on requested_by's RLS-
  // restricted profiles join.
  const subIds = (subs || []).map((s: any) => s.id)
  const requesterBySubId = new Map<string, string>()
  if (subIds.length) {
    const { data: auditRows, error: auditError } = await supabase
      .from('audit_log')
      .select('subscription_id, performed_by, created_at')
      .in('subscription_id', subIds)
      .eq('action', 'requested')
      .order('created_at', { ascending: false })
    if (auditError) throw auditError
    for (const row of auditRows || []) {
      if (!requesterBySubId.has(row.subscription_id)) requesterBySubId.set(row.subscription_id, row.performed_by)
    }
  }

  // userEmail (who the license is for) and requesterEmail (who submitted it)
  // are tracked separately, unlike GAS's original digest, which only ever had
  // one email per row — self-service was the only path back then. The new
  // app supports requesting on behalf of someone else, so an owner approving
  // a request-for-others case genuinely needs to see both.
  const byOwner = new Map<string, { suiteKey: string; licenseName: string; userEmail: string; requesterEmail: string; price: number | string | null; priceUnit: string | null }[]>()
  for (const sub of subs || []) {
    const owner = ownerBySK.get(sub.suite_key)
    if (!owner) continue
    if (!byOwner.has(owner)) byOwner.set(owner, [])
    byOwner.get(owner)!.push({
      suiteKey: sub.suite_key,
      licenseName: sub.license?.name || 'License',
      userEmail: sub.user_email,
      requesterEmail: requesterBySubId.get(sub.id) || sub.user_email,
      price: sub.license?.price ?? null,
      priceUnit: sub.license?.price_unit ?? null,
    })
  }

  const ownerEntries = typeof limit === 'number' ? [...byOwner].slice(0, limit) : [...byOwner]

  let emailsSent = 0
  const errors: { email: string; error: string }[] = []
  for (const [owner, rows] of ownerEntries) {
    try {
      const rowsHtml = rows.map(r => `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0">${r.suiteKey}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0">${r.licenseName}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0">${priceLabel(r.price, r.priceUnit)}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0">${r.requesterEmail}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #e0e0e0">${r.userEmail.toLowerCase() === r.requesterEmail.toLowerCase() ? '(self)' : r.userEmail}</td>
        </tr>`).join('')
      const count = rows.length

      const { error: sendError } = await supabase.functions.invoke('send-email', {
        headers: { Authorization: `Bearer ${serviceRoleKey}` },
        body: {
          to: owner,
          subject: `Reminder: ${count} license request${count === 1 ? '' : 's'} awaiting your approval`,
          html: pendingDigestHtml({
            heading: 'License Manager — Approval Required',
            intro: `The following license request${count === 1 ? ' is' : 's are'} waiting for your approval.`,
            columns: ['SuiteKey', 'License', 'Cost', 'Requested by', 'For'],
            rowsHtml,
          }),
          template: 'approval_reminder',
        },
      })
      if (sendError) throw sendError
      emailsSent++
    } catch (err) {
      const detail = err.context ? await err.context.text().catch(() => null) : null
      console.error(`approval reminder failed for ${owner}: ${err.message}${detail ? ` — ${detail}` : ''}`)
      errors.push({ email: owner, error: detail || err.message })
    }
  }
  return { emailsSent, ownersNotified: byOwner.size, errors }
}

// Deliberate duplicate of priceLabel()/formatPrice() in src/lib/email.js —
// see this file's header comment on why it can't import that module. The
// Number() is load-bearing: Postgres numeric columns come through
// supabase-js as strings, which have no .toFixed().
function priceLabel(price: number | string | null, priceUnit: string | null): string {
  if (price == null) return '—'
  const n = Number(price)
  const formatted = n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`
  return priceUnit ? `${formatted} ${priceUnit}` : formatted
}

function pendingDigestHtml({ heading, intro, columns, rowsHtml }: { heading: string; intro: string; columns: string[]; rowsHtml: string }) {
  const headerCells = columns.map(c => `<th style="padding:10px 12px;text-align:left;border-bottom:2px solid #e0e0e0">${c}</th>`).join('')
  return `
<div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto; color: #202124;">
  <h2 style="color: #005CB9; margin: 0 0 16px; font-size: 20px;">${heading}</h2>
  <p>${intro}</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0">
    <thead><tr style="background:#f8f9fa">${headerCells}</tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <p style="color: #666666; font-size: 12px; margin-top: 24px;">
    You can also act on this from <a href="${APP_ORIGIN}/action-center" style="color: #005CB9;">License Manager → Action Center</a>.
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

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { classifyCaller, resolveSender } from './auth.ts'

const RESEND_API_URL = 'https://api.resend.com/emails'
// Sender identity comes from resolveSender() in auth.ts (per-app, chosen server-side).

interface EmailRequest {
  to: string | string[]
  subject: string
  html: string
  template: string
  /** Which app is sending; selects the sender identity. Defaults to 'licenses'. Non-default apps are server-to-server only. */
  app?: string
  subscription_id?: string
  bcc?: string[]
  cc?: string[]
  /** Overrides the sender's default reply-to. Honored for server callers only (e.g. feedback → help desk, replying to the submitter). */
  reply_to?: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() })
  }

  try {
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey)

    // Deployed with --no-verify-jwt (see supabase/functions/README.md), so
    // this is the only gate: an open endpoint here would let anyone on the
    // internet send arbitrary HTML from our domain. Callers are either our
    // own Edge Functions (service-role key / CRON_SECRET) or a signed-in user
    // with a profile in this app. See auth.ts.
    let userIdentity: string | null = null
    const caller = await classifyCaller(req.headers.get('Authorization'), {
      serviceRoleKey,
      cronSecret: Deno.env.get('CRON_SECRET'),
      isValidUserToken: async (token) => {
        userIdentity = await verifiedUserIdentity(supabase, token)
        return userIdentity !== null
      },
    })
    if (!caller) {
      return json({ error: 'Unauthorized' }, 401)
    }
    const sentBy = caller === 'server' ? 'system' : userIdentity

    const body: EmailRequest = await req.json()
    const { to, subject, html, template, app, subscription_id, bcc, cc, reply_to } = body

    const sender = resolveSender(app, { contractsReplyTo: Deno.env.get('CONTRACTS_REPLY_TO') })
    if (!sender) {
      return json({ error: 'Unknown app' }, 400)
    }
    if (sender.serverOnly && caller !== 'server') {
      return json({ error: 'Forbidden' }, 403)
    }

    if (!to || (Array.isArray(to) && !to.length) || !subject || !html || !template) {
      return json({ error: 'Missing required fields: to, subject, html, template' }, 400)
    }
    // Resend accepts either a single address or an array (up to 50) in `to` —
    // one real email with every recipient in the To field, not one send per
    // recipient (which would also mean each recipient sees only themselves,
    // not who else was notified).
    const toEmail = Array.isArray(to) ? to.join(', ') : to
    // email_log has no separate cc column — fold it into to_email so the log
    // still shows who actually received the email (e.g. a renewal reminder's
    // original requester, CC'd alongside the subscription owner).
    const toEmailLog = cc?.length ? `${toEmail} (cc: ${cc.join(', ')})` : toEmail

    // A browser caller must not be able to point replies at an arbitrary
    // address on mail from our domain, so only server callers may override.
    const replyTo = caller === 'server' && reply_to && /^[^\s@<>,]+@[^\s@<>,]+$/.test(reply_to)
      ? reply_to
      : sender.replyTo

    // Send via Resend
    const resendRes = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: sender.from, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}),
        ...(bcc?.length ? { bcc } : {}),
        ...(cc?.length ? { cc } : {}),
      }),
    })

    const resendData = await resendRes.json()
    const status = resendRes.ok ? 'sent' : 'failed'
    const error = resendRes.ok ? null : JSON.stringify(resendData)

    // Log to database regardless of send success/failure
    await supabase.from('email_log').insert({
      to_email: toEmailLog,
      subject,
      template,
      subscription_id: subscription_id || null,
      resend_id: resendData.id || null,
      status,
      error,
      sent_by: sentBy,
    })

    if (!resendRes.ok) {
      return json({ error: 'Failed to send email', detail: resendData }, 500)
    }

    return json({ success: true, id: resendData.id })
  } catch (err) {
    return json({ error: err.message }, 500)
  }
})

// Returns the verified user's email (for email_log.sent_by), or null if the
// token isn't a signed-in user of this app.
async function verifiedUserIdentity(
  supabase: SupabaseClient,
  token: string
): Promise<string | null> {
  // getUser(token) validates the JWT against the auth server — a forged or
  // expired token (or the public anon key) comes back with no user.
  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) return null

  // A valid session isn't enough on its own: this project is shared with
  // other apps, so also require a linked profile (i.e. an eligible staff
  // member who has signed in here — see resolve_profile()).
  const { data: link } = await supabase
    .from('linked_accounts')
    .select('profile_id')
    .eq('supabase_user_id', user.id)
    .maybeSingle()
  if (!link) return null

  return user.email ?? user.id
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  })
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
}

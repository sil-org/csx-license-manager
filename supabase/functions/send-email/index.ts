import { createClient } from 'jsr:@supabase/supabase-js@2'
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
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() })
  }

  try {
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey)

    // This function is deployed with --no-verify-jwt, so it authenticates callers itself.
    // It previously only checked that an Authorization header *existed* — any value passed.
    // Now: the service-role key / CRON_SECRET (our own Edge Functions) or a valid signed-in
    // user's access token (the browser app). See auth.ts.
    const caller = await classifyCaller(req.headers.get('Authorization'), {
      serviceRoleKey,
      cronSecret: Deno.env.get('CRON_SECRET'),
      isValidUserToken: async (token) => {
        const { data, error } = await supabase.auth.getUser(token)
        return !error && !!data?.user
      },
    })
    if (!caller) {
      return json({ error: 'Unauthorized' }, 401)
    }

    const body: EmailRequest = await req.json()
    const { to, subject, html, template, app, subscription_id, bcc, cc } = body

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

    // Send via Resend
    const resendRes = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: sender.from, to, subject, html, ...(sender.replyTo ? { reply_to: sender.replyTo } : {}),
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
    })

    if (!resendRes.ok) {
      return json({ error: 'Failed to send email', detail: resendData }, 500)
    }

    return json({ success: true, id: resendData.id })
  } catch (err) {
    return json({ error: err.message }, 500)
  }
})

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

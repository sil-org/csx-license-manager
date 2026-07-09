import { createClient } from 'jsr:@supabase/supabase-js@2'

const RESEND_API_URL = 'https://api.resend.com/emails'
// TODO: replace with a domain verified in Resend for this project.
const FROM = 'License Manager <licenses@sil.org>'

interface EmailRequest {
  to: string
  subject: string
  html: string
  template: string
  subscription_id?: string
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'Unauthorized' }, 401)
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const body: EmailRequest = await req.json()
    const { to, subject, html, template, subscription_id } = body

    if (!to || !subject || !html || !template) {
      return json({ error: 'Missing required fields: to, subject, html, template' }, 400)
    }

    // Send via Resend
    const resendRes = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    })

    const resendData = await resendRes.json()
    const status = resendRes.ok ? 'sent' : 'failed'
    const error = resendRes.ok ? null : JSON.stringify(resendData)

    // Log to database regardless of send success/failure
    await supabase.from('email_log').insert({
      to_email: to,
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

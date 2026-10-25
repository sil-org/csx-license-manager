import { createClient } from 'jsr:@supabase/supabase-js@2'

const HELPDESK_EMAIL = 'helpdesk+licenses@sil.org'

const TYPE_LABELS: Record<FeedbackRequest['type'], string> = {
  bug: 'Bug',
  feature: 'Feature request',
  comment: 'Comment',
}

interface FeedbackRequest {
  type: 'bug' | 'feature' | 'comment'
  title: string
  description: string
  context?: { userId?: string; page?: string }
}

// Receives a submission from FeedbackWidget.jsx and emails it to the help
// desk, with reply-to set to the submitter so the help desk can answer them
// directly. Every submission — bug, feature or comment — goes here; nothing is
// filed as a GitHub issue. Sent through send-email so it is logged in
// email_log like every other message from this app.
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() })
  }

  try {
    // Deployed with --no-verify-jwt, so verify the caller here: a real
    // signed-in user, not just any Authorization header.
    const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim()
    if (!token) {
      return json({ error: 'Unauthorized' }, 401)
    }
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!)
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) {
      return json({ error: 'Unauthorized' }, 401)
    }

    const body: FeedbackRequest = await req.json()
    const { type, title, description, context } = body

    if (!title?.trim() || !description?.trim()) {
      return json({ error: 'Title and description are required.' }, 400)
    }
    if (!(type in TYPE_LABELS)) {
      return json({ error: 'Invalid feedback type.' }, 400)
    }

    // User comes from the verified session, not the client-supplied context.
    const submitter = user.email ?? user.id
    const page = context?.page?.trim()

    // send-email trusts the service-role key as a server caller, which is
    // what lets us set reply_to to the submitter.
    const emailRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-email`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: HELPDESK_EMAIL,
        ...(user.email ? { reply_to: user.email } : {}),
        subject: `[License Manager] ${TYPE_LABELS[type]}: ${title.trim()}`,
        template: 'feedback',
        html: `
          <p><strong>${TYPE_LABELS[type]}</strong> from ${escapeHtml(submitter)}</p>
          <p style="white-space:pre-wrap">${escapeHtml(description.trim())}</p>
          <hr>
          <p style="color:#666;font-size:12px">
            User: ${escapeHtml(submitter)}${page ? `<br>Page: ${escapeHtml(page)}` : ''}<br>
            Reply to this email to respond to the user.
          </p>`,
      }),
    })

    if (!emailRes.ok) {
      console.error('send-email error:', emailRes.status, await emailRes.text())
      return json({ error: 'Could not send the feedback email.' }, 502)
    }

    return json({ ok: true })
  } catch (err) {
    console.error('feedback function error:', err)
    return json({ error: err.message }, 500)
  }
})

function escapeHtml(str: string) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
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

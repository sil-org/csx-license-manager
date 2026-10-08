import { createClient } from 'jsr:@supabase/supabase-js@2'

const GITHUB_API = 'https://api.github.com'

// Label per type, decided here rather than taken from the request, so a
// caller can't attach arbitrary labels to issues in the repo.
const LABELS: Record<FeedbackRequest['type'], string> = {
  bug: 'bug',
  feature: 'enhancement',
  comment: 'comment',
}

interface FeedbackRequest {
  type: 'bug' | 'feature' | 'comment'
  title: string
  description: string
  context?: { userId?: string; page?: string }
}

// Receives a submission from FeedbackWidget.jsx and files it as a GitHub
// issue in the (private) repo, tagged with a label matching the type plus
// "user-submitted". The repo is private and submitters never see the
// resulting issue, so this is a one-way "thanks, we got it" flow, not a
// tracker — the response never includes the issue URL or number.
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
    const allowedTypes = ['bug', 'feature', 'comment']
    if (!allowedTypes.includes(type)) {
      return json({ error: 'Invalid feedback type.' }, 400)
    }

    // User comes from the verified session, not the client-supplied context.
    const contextBlock = ['', '---', '**Context**', `- User: ${user.email ?? user.id}`, context?.page ? `- Page: ${context.page}` : null]
      .filter(Boolean)
      .join('\n')

    const ghResponse = await fetch(
      `${GITHUB_API}/repos/${Deno.env.get('GITHUB_OWNER')}/${Deno.env.get('GITHUB_REPO')}/issues`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${Deno.env.get('GITHUB_TOKEN')}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: title.trim(),
          body: `${description.trim()}\n${contextBlock}`,
          labels: [LABELS[type], 'user-submitted'],
        }),
      }
    )

    if (!ghResponse.ok) {
      const errText = await ghResponse.text()
      console.error('GitHub API error:', ghResponse.status, errText)
      return json({ error: 'Could not create the issue upstream.' }, 502)
    }

    return json({ ok: true })
  } catch (err) {
    console.error('feedback function error:', err)
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

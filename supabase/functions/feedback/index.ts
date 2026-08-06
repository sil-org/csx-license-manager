const GITHUB_API = 'https://api.github.com'

interface FeedbackRequest {
  type: 'bug' | 'feature' | 'comment'
  githubLabel: string
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
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return json({ error: 'Unauthorized' }, 401)
    }

    const body: FeedbackRequest = await req.json()
    const { type, githubLabel, title, description, context } = body

    if (!title?.trim() || !description?.trim()) {
      return json({ error: 'Title and description are required.' }, 400)
    }
    const allowedTypes = ['bug', 'feature', 'comment']
    if (!allowedTypes.includes(type)) {
      return json({ error: 'Invalid feedback type.' }, 400)
    }

    const contextBlock = context
      ? ['', '---', '**Context**', context.userId ? `- User: ${context.userId}` : null, context.page ? `- Page: ${context.page}` : null]
          .filter(Boolean)
          .join('\n')
      : ''

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
          labels: [githubLabel || type, 'user-submitted'],
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

import { createClient } from 'jsr:@supabase/supabase-js@2'

// Classifies a suggested-approver email address as a Google Group or an
// individual, using the Admin SDK Directory API's Groups: get endpoint (an
// existence check only — this never lists members, see sync-group-memberships
// for that). Called client-side (src/lib/subscriptions.js) before
// request_subscription() whenever a requester types a suite key's suggested
// approver, so a group address typed into that field gets tagged
// pending_approver_is_group and routed onto the group-confirmation path
// (any current member can confirm) instead of silently landing on the
// individual exact-match check that no one in the group could ever satisfy —
// see 2026-09-01's operations_gslt@sil.org / alan_yam@sil.org incident,
// where the group's own notification email reached a real member but the
// app never recognized them as the suggested approver.
//
// Requires a signed-in caller (same as every other RPC-adjacent Edge
// Function here) but doesn't need to know *who* — the answer "is this a
// group" isn't sensitive, and the actual authorization checks all happen in
// Postgres afterward.
//
// Auth: same service account and scope as sync-group-memberships/index.ts —
// no new Workspace grant needed.

const SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.readonly'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return json({ error: 'Unauthorized' }, 401)

    const { email } = await req.json()
    const trimmed = (email || '').trim().toLowerCase()
    if (!trimmed) return json({ error: 'email is required' }, 400)

    const accessToken = await getAccessToken()
    const res = await fetch(
      `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(trimmed)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    )
    if (res.status === 404) return json({ type: 'individual' })
    if (!res.ok) throw new Error(`groups.get failed: ${res.status} ${await res.text()}`)
    return json({ type: 'group' })
  } catch (err) {
    console.error('classify-approver-email error:', err)
    return json({ error: err.message }, 500)
  }
})

// ─── Google service-account JWT auth (RS256, signed with Web Crypto) ───────
// Duplicated from sync-group-memberships/index.ts rather than shared — no
// _shared folder convention in this repo, each Edge Function directory is
// its own deploy bundle (see that file's own copy of this comment).

async function getAccessToken(): Promise<string> {
  const email = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_EMAIL')!
  const privateKeyPem = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')!

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss: email,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const key = await importPrivateKey(privateKeyPem)
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const jwt = `${unsigned}.${base64url(signature)}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  if (!res.ok) throw new Error(`Failed to get access token: ${res.status} ${await res.text()}`)
  const { access_token } = await res.json()
  return access_token
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const contents = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '')
  const der = Uint8Array.from(atob(contents), c => c.charCodeAt(0))
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
}

function base64url(input: string | ArrayBuffer): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
  let str = ''
  for (const b of bytes) str += String.fromCharCode(b)
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
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

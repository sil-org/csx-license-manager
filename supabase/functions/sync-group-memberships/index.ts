import { createClient } from 'jsr:@supabase/supabase-js@2'

// Refreshes the group_memberships cache table from Google's Admin SDK
// Directory API — the only way suite_keys.owner_group_email authorization
// checks work, since Postgres RLS can't make live calls to Google. Also
// backs the group-suggested-approver confirmation path (subscriptions.
// pending_approver_is_group) — a suite key with no owner yet can have a
// group named as its suggested approver, and get_my_pending_sk_verifications()/
// confirm_sk_ownership() need a live-ish roster to check "is the caller
// currently a member of that group" before it's ever been claimed.
//
// Syncs groups referenced as a suite_keys.owner_group_email, plus any group
// currently named as a pending_sk_verification row's suggested approver —
// never the whole organization's group directory. Call this on a schedule
// (Supabase Scheduled Functions, or pg_cron + pg_net if that's not available)
// — every 15-60 min is plenty given how infrequently these rosters change.
//
// Auth: the service account authenticates as itself — no impersonation, no
// domain-wide delegation. It's been directly assigned a Workspace admin role
// (Admin Console → Account → Admin roles → Groups Admin (or a custom role
// scoped to just Groups) → Admins tab → Assign service accounts), narrowly
// scoped to admin.directory.group.readonly +
// admin.directory.group.member.readonly — nothing else. This was a
// deliberate choice over domain-wide delegation: DWD grants "impersonate any
// user in the domain for these scopes," which is broader than this needs and
// ties the grant to acting *as* some admin's identity; a role assigned
// directly to the service account is scoped to exactly Groups, is its own
// auditable principal, and doesn't depend on any particular human admin
// account continuing to exist. See the setup notes at the bottom of this
// file for what a Workspace super admin needs to do once, by hand, to
// authorize it.
//
// Required secrets (Supabase Edge Function secrets, not the frontend .env):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL       the service account's own email
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY its PEM private key (the "private_key"
//                                      field from the downloaded JSON key file)

const DIRECTORY_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
].join(' ')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() })

  // Scheduled job only — deployed with --no-verify-jwt, so gate it on the
  // same CRON_SECRET as send-*-reminders (or the service-role key, for a
  // manual run). Without this, anyone could trigger Directory API calls and
  // rewrite the group_memberships cache that authorization checks read.
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const cronSecret = Deno.env.get('CRON_SECRET')
  const token = req.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (!token || (token !== serviceRoleKey && (!cronSecret || token !== cronSecret))) {
    return json({ error: 'Unauthorized' }, 401)
  }

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey)

    const { data: ownedRows, error: ownedError } = await supabase
      .from('suite_keys')
      .select('owner_group_email')
      .not('owner_group_email', 'is', null)
    if (ownedError) throw ownedError

    const { data: pendingRows, error: pendingError } = await supabase
      .from('subscriptions')
      .select('pending_approver_email')
      .eq('status', 'pending_sk_verification')
      .eq('pending_approver_is_group', true)
    if (pendingError) throw pendingError

    const groupEmails = [...new Set([
      ...(ownedRows || []).map(r => r.owner_group_email),
      ...(pendingRows || []).map(r => r.pending_approver_email),
    ].filter(Boolean))]
    if (!groupEmails.length) {
      return json({ ok: true, groupsSynced: 0, message: 'No suite_keys currently have a Google Group owner or suggested group approver.' })
    }

    const accessToken = await getAccessToken()
    const summary = []

    for (const groupEmail of groupEmails) {
      let members: string[]
      try {
        members = await listGroupMembers(accessToken, groupEmail)
      } catch (err) {
        // Leave this group's cache untouched on failure rather than treat
        // "API call failed" the same as "group genuinely has zero members" —
        // the latter should clear the cache, the former shouldn't touch it.
        console.error(`Skipping ${groupEmail}: ${err.message}`)
        summary.push({ groupEmail, error: err.message })
        continue
      }

      // Replace this group's full membership set — upsert current members,
      // delete anyone no longer present so removals are reflected too.
      if (members.length) {
        const { error: upsertError } = await supabase
          .from('group_memberships')
          .upsert(
            members.map(email => ({ group_email: groupEmail, member_email: email, synced_at: new Date().toISOString() })),
            { onConflict: 'group_email,member_email' }
          )
        if (upsertError) throw upsertError
        const { error: deleteError } = await supabase
          .from('group_memberships')
          .delete()
          .eq('group_email', groupEmail)
          .not('member_email', 'in', `(${members.join(',')})`)
        if (deleteError) throw deleteError
      } else {
        // Genuinely zero current members (API call succeeded, list was
        // empty) — clear the cache for this group entirely.
        const { error: deleteError } = await supabase.from('group_memberships').delete().eq('group_email', groupEmail)
        if (deleteError) throw deleteError
      }

      summary.push({ groupEmail, memberCount: members.length })
    }

    return json({ ok: true, groupsSynced: summary.length, summary })
  } catch (err) {
    console.error(err)
    return json({ error: err.message }, 500)
  }
})

async function listGroupMembers(accessToken: string, groupEmail: string): Promise<string[]> {
  const emails: string[] = []
  let pageToken: string | undefined

  do {
    const url = new URL(`https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(groupEmail)}/members`)
    url.searchParams.set('maxResults', '200')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) {
      // Throws rather than returning [] — the caller treats "API call
      // failed" differently from "group genuinely has zero members".
      throw new Error(`Failed to list members of ${groupEmail}: ${res.status} ${await res.text()}`)
    }
    const data = await res.json()
    for (const m of data.members || []) {
      if (m.email) emails.push(m.email.toLowerCase())
    }
    pageToken = data.nextPageToken
  } while (pageToken)

  return emails
}

// ─── Google service-account JWT auth (RS256, signed with Web Crypto) ───────
// Deliberately not using the `googleapis`/`google-auth-library` npm packages
// here — they're heavy Node-oriented libraries that don't sit well in Deno's
// npm compat layer. This is the whole OAuth2 service-account flow in ~30
// lines using only built-ins (Web Crypto + fetch).

async function getAccessToken(): Promise<string> {
  const email = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_EMAIL')!
  const privateKeyPem = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')!

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss: email,
    scope: DIRECTORY_SCOPES,
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

// ─── One-time setup a Workspace super admin needs to do by hand ────────────
// 1. Google Cloud Console (use an org-owned project, not a personal one):
//    - Create/select a project, enable the "Admin SDK API".
//    - Create a service account, generate a JSON key, note its email (the
//      "client_email" field) and its "private_key" field.
//    - Note the service account's unique ID too (GCP IAM → the service
//      account → Details — a numeric "Unique ID", not its email), needed
//      for step 2.
// 2. Google Workspace Admin Console → Account → Admin roles:
//    - Pick "Groups Admin" (built-in), or create a custom role scoped to
//      just the Groups privileges this needs.
//    - Open that role → Admins tab → Assign service accounts → search for
//      the service account by the unique ID from step 1 → assign.
//    This grants the role to the service account directly, as itself — no
//    domain-wide delegation, no impersonating a human admin's identity.
// 3. Set these as Supabase Edge Function secrets (Project Settings > Edge
//    Functions, or `supabase secrets set`):
//      GOOGLE_SERVICE_ACCOUNT_EMAIL
//      GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY   (paste the full PEM, including
//                                            the BEGIN/END lines)
// 4. Deploy this function, then schedule it (Supabase Scheduled Functions,
//    or pg_cron calling it via pg_net) — every 15-60 min is plenty.

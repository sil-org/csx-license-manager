// Keeps a license's Google Group membership in sync with its active
// subscribers — nothing more. This is NOT a claim that group membership
// *is* how the license gets provisioned, the way cubebackup.ts's adapter
// genuinely is CubeBackup's provisioning mechanism. For a Google-native
// surface like Vids, group membership and access happen to be the same
// fact (Workspace lets you scope an app to "selected groups," so being in
// the group *is* having access) — but that's a property of Vids, not of
// this code. For any other license, this is an independent side-action
// (e.g. a shared support/comms list) with no bearing on whether the actual
// seat exists on the vendor's side — per our own research, none of Zoom,
// Claude Team/Enterprise, etc. support provisioning a seat via API at all
// right now; that's still a manual step in each vendor's own console
// regardless of what this file does.
//
// Deliberately NOT dispatched through licenses.provisioning_adapter like
// cubebackup.ts — google_group_email is already its own dedicated licenses
// column (Admin -> Catalog has had the field for a while; only the actual
// sync was ever a TODO — see activate_subscription()'s audit note in
// supabase/schema_licenses.sql). Asking an admin to also select an adapter
// and re-type the same address into provisioning_config would just be a
// second place for the same fact to drift out of sync. See index.ts for the
// separate pass that calls this — keyed off google_group_email directly,
// independent of the provisioning_adapter dispatch loop. It lives alongside
// the provisioning adapters only because it wants the same trigger cadence
// (recomputed from active subscriptions, kicked immediately on activate/
// cancel) — not because it's the same kind of thing conceptually.
//
// Auth: the same domain-wide-delegated service account as
// sync-group-memberships/index.ts, just with one more scope added to its
// existing delegation — admin.directory.group.member (read/write) instead
// of that function's two readonly scopes. Same Client ID, same one-time
// Workspace Admin Console grant, just an additional scope on it. See that
// file's setup notes for the original grant.
//
// Required secrets — same three as sync-group-memberships, reused as-is
// (Supabase Edge Function secrets are project-wide, not per-function):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//   GOOGLE_ADMIN_IMPERSONATE_EMAIL

interface SyncResult {
  enabled: string[]
  disabled: string[]
  errors: { email: string; message: string }[]
}

const SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.member'

export async function googleGroupSync(groupEmail: string, desiredEmails: string[]): Promise<SyncResult> {
  const accessToken = await getAccessToken()
  const desiredSet = new Set(desiredEmails.map(e => e.toLowerCase()))
  const currentMembers = await listMembers(accessToken, groupEmail)
  const currentSet = new Set(currentMembers.map(e => e.toLowerCase()))

  const enabled: string[] = []
  const disabled: string[] = []
  const errors: { email: string; message: string }[] = []

  for (const email of desiredEmails) {
    if (currentSet.has(email.toLowerCase())) continue
    try {
      await addMember(accessToken, groupEmail, email)
      enabled.push(email)
    } catch (err) {
      errors.push({ email, message: err.message })
    }
  }

  for (const email of currentMembers) {
    if (desiredSet.has(email.toLowerCase())) continue
    try {
      await removeMember(accessToken, groupEmail, email)
      disabled.push(email)
    } catch (err) {
      errors.push({ email, message: err.message })
    }
  }

  return { enabled, disabled, errors }
}

async function listMembers(accessToken: string, groupEmail: string): Promise<string[]> {
  const emails: string[] = []
  let pageToken: string | undefined

  do {
    const url = new URL(`https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(groupEmail)}/members`)
    url.searchParams.set('maxResults', '200')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new Error(`list members of ${groupEmail} failed: ${res.status} ${await res.text()}`)
    const data = await res.json()
    for (const m of data.members || []) {
      if (m.email) emails.push(m.email.toLowerCase())
    }
    pageToken = data.nextPageToken
  } while (pageToken)

  return emails
}

async function addMember(accessToken: string, groupEmail: string, memberEmail: string): Promise<void> {
  const res = await fetch(`https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(groupEmail)}/members`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: memberEmail, role: 'MEMBER' }),
  })
  // 409 = already a member — e.g. an admin added them by hand, or a prior
  // run's insert succeeded but the response was lost. Not an error.
  if (!res.ok && res.status !== 409) {
    throw new Error(`add ${memberEmail} to ${groupEmail} failed: ${res.status} ${await res.text()}`)
  }
}

async function removeMember(accessToken: string, groupEmail: string, memberEmail: string): Promise<void> {
  const res = await fetch(
    `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(groupEmail)}/members/${encodeURIComponent(memberEmail)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
  )
  // 404 = already not a member. Not an error, same reasoning as the 409 above.
  if (!res.ok && res.status !== 404) {
    throw new Error(`remove ${memberEmail} from ${groupEmail} failed: ${res.status} ${await res.text()}`)
  }
}

// ─── Google service-account JWT auth (RS256, signed with Web Crypto) ───────
// Duplicated from sync-group-memberships/index.ts rather than shared — no
// _shared folder convention in this repo, each Edge Function directory is
// its own deploy bundle (see that file's own copy of this comment).

async function getAccessToken(): Promise<string> {
  const email = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_EMAIL')!
  const privateKeyPem = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY')!
  const impersonate = Deno.env.get('GOOGLE_ADMIN_IMPERSONATE_EMAIL')!

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = {
    iss: email,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    sub: impersonate,
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

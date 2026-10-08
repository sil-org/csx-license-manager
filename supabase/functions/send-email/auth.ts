// Who is allowed to call send-email.
//
// send-email is deployed with --no-verify-jwt (see supabase/functions/README.md for why this
// project can't use the platform JWT gate), so it must authenticate callers itself. It used to
// only check that an Authorization header was *present*, which let anyone who knew the function
// URL send arbitrary email from em.sil.org.
//
// Accepted callers:
//   'server' — the service-role key or CRON_SECRET: our own Edge Functions (the scheduled
//              reminder functions in license-manager and contract-repository).
//   'user'   — a valid, unexpired Supabase access token of a signed-in user (the browser app);
//              index.ts's validator also requires a linked_accounts profile in this app.
// Everything else is rejected.

export type Caller = 'server' | 'user' | null

export interface AuthDeps {
  serviceRoleKey?: string
  cronSecret?: string
  /** Resolves true if `token` is a valid Supabase user access token. */
  isValidUserToken: (token: string) => Promise<boolean>
}

// Constant-time comparison so a secret can't be guessed byte by byte from response timing.
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const x = enc.encode(a), y = enc.encode(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

export async function classifyCaller(authHeader: string | null, deps: AuthDeps): Promise<Caller> {
  const match = authHeader?.match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  const token = match[1].trim()
  if (!token) return null

  if (deps.serviceRoleKey && safeEqual(token, deps.serviceRoleKey)) return 'server'
  if (deps.cronSecret && safeEqual(token, deps.cronSecret)) return 'server'

  try {
    return (await deps.isValidUserToken(token)) ? 'user' : null
  } catch {
    return null
  }
}

// Sender identities. Chosen server-side from this list — callers never supply `from`.
// 'licenses' is the default so existing callers behave exactly as before.
export interface Sender { from: string; replyTo?: string; serverOnly: boolean }

export function resolveSender(app: unknown, env: { contractsReplyTo?: string } = {}): Sender | null {
  switch (app ?? 'licenses') {
    case 'licenses':
      return { from: 'License Manager <license_manager@em.sil.org>', replyTo: 'helpdesk+licenses@sil.org', serverOnly: false }
    case 'contracts':
      return { from: 'Contract Repository <contracts@em.sil.org>', replyTo: env.contractsReplyTo || undefined, serverOnly: true }
    default:
      return null
  }
}

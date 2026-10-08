// End-to-end check of the real send-email handler with Resend + Supabase mocked at the fetch layer.
// Run: deno run -A --no-check supabase/functions/send-email/e2e_check.ts
let handler: (r: Request) => Promise<Response> = () => { throw new Error('no handler') }
// deno-lint-ignore no-explicit-any
;(Deno as any).serve = (h: typeof handler) => { handler = h; return {} }
Deno.env.set('SUPABASE_URL', 'http://mock.supabase')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
Deno.env.set('CRON_SECRET', 'cron-secret')
Deno.env.set('RESEND_API_KEY', 're_test')

const resendCalls: Record<string, unknown>[] = []
const logRows: Record<string, unknown>[] = []
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input, init); const url = new URL(req.url)
  if (url.host === 'api.resend.com') { resendCalls.push(await req.json()); return Response.json({ id: 're_1' }) }
  if (url.pathname === '/auth/v1/user') {
    return req.headers.get('authorization') === 'Bearer user-good'
      ? Response.json({ id: 'u1', aud: 'authenticated', email: 'a@sil.org' }) : Response.json({ msg: 'bad jwt' }, { status: 401 })
  }
  if (url.pathname === '/rest/v1/email_log') { logRows.push(await req.json()); return new Response(null, { status: 201 }) }
  throw new Error('unexpected fetch ' + req.url)
}
await import('./index.ts')

const send = async (auth: string | null, extra: Record<string, unknown> = {}) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) headers.Authorization = auth
  const res = await handler(new Request('http://x/send-email', { method: 'POST', headers,
    body: JSON.stringify({ to: 'p@sil.org', subject: 's', html: '<p>h</p>', template: 't', ...extra }) }))
  return res.status
}
let failed = 0
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`)
}

check('no Authorization header -> 401', await send(null), 401)
check('THE OLD HOLE: "Bearer anything" -> 401', await send('Bearer anything'), 401)
check('THE OLD HOLE: arbitrary non-bearer value -> 401', await send('hello'), 401)
check('invalid user token -> 401', await send('Bearer user-bad'), 401)
check('nothing was sent for any rejected request', resendCalls.length, 0)

check('license-manager reminders (service-role key) -> 200', await send('Bearer service-key'), 200)
check('  ...sent as License Manager, unchanged', [resendCalls.at(-1)!.from, resendCalls.at(-1)!.reply_to], ['License Manager <license_manager@em.sil.org>', 'helpdesk+licenses@sil.org'])
check('license-manager browser (valid user token) -> 200', await send('Bearer user-good'), 200)
check('  ...sent as License Manager, unchanged', resendCalls.at(-1)!.from, 'License Manager <license_manager@em.sil.org>')
check('explicit app: "licenses" from browser -> 200', await send('Bearer user-good', { app: 'licenses' }), 200)

check('contract reminders (CRON_SECRET, app contracts) -> 200', await send('Bearer cron-secret', { app: 'contracts' }), 200)
check('  ...sent as Contract Repository', resendCalls.at(-1)!.from, 'Contract Repository <contracts@em.sil.org>')
check('  ...no reply_to when CONTRACTS_REPLY_TO unset', 'reply_to' in resendCalls.at(-1)!, false)
check('browser user cannot send as contracts -> 403', await send('Bearer user-good', { app: 'contracts' }), 403)
check('unknown app -> 400', await send('Bearer service-key', { app: 'evil' }), 400)
check('a caller-supplied "from" is ignored', await send('Bearer service-key', { from: 'CEO <ceo@sil.org>' }), 200)
check('  ...still sent from the fixed sender', resendCalls.at(-1)!.from, 'License Manager <license_manager@em.sil.org>')
check('every accepted send was logged to email_log', logRows.length, resendCalls.length)
Deno.exit(failed ? 1 : 0)

// Run: deno test supabase/functions/send-email/auth_test.ts
import { classifyCaller, resolveSender, safeEqual } from './auth.ts'

const deps = (valid: string[] = []) => ({
  serviceRoleKey: 'service-key', cronSecret: 'cron-secret',
  isValidUserToken: (t: string) => Promise.resolve(valid.includes(t)),
})
const eq = (got: unknown, want: unknown, msg: string) => { if (got !== want) throw new Error(`${msg}: got ${got}, want ${want}`) }

Deno.test('no header / empty / wrong scheme are rejected', async () => {
  eq(await classifyCaller(null, deps()), null, 'no header')
  eq(await classifyCaller('', deps()), null, 'empty header')
  eq(await classifyCaller('Bearer ', deps()), null, 'empty bearer')
  eq(await classifyCaller('Basic abc', deps()), null, 'basic scheme')
})

Deno.test('the old hole is closed: any arbitrary header value is rejected', async () => {
  eq(await classifyCaller('Bearer anything', deps()), null, 'arbitrary bearer')
  eq(await classifyCaller('Bearer x.y.z', deps()), null, 'fake jwt')
  eq(await classifyCaller('anything', deps()), null, 'no scheme')
})

Deno.test('service-role key and CRON_SECRET are server callers', async () => {
  eq(await classifyCaller('Bearer service-key', deps()), 'server', 'service key')
  eq(await classifyCaller('Bearer cron-secret', deps()), 'server', 'cron secret')
  eq(await classifyCaller('bearer cron-secret', deps()), 'server', 'case-insensitive scheme')
})

Deno.test('unset secrets never match an empty or missing token', async () => {
  const d = { isValidUserToken: () => Promise.resolve(false) }
  eq(await classifyCaller('Bearer undefined', d), null, 'literal "undefined"')
  eq(await classifyCaller('Bearer ', d), null, 'empty')
})

Deno.test('valid user tokens are user callers; invalid or throwing validators are rejected', async () => {
  eq(await classifyCaller('Bearer good', deps(['good'])), 'user', 'valid token')
  eq(await classifyCaller('Bearer bad', deps(['good'])), null, 'invalid token')
  eq(await classifyCaller('Bearer boom', { ...deps(), isValidUserToken: () => Promise.reject(new Error('net')) }), null, 'validator error')
})

Deno.test('a near-miss of a secret is rejected', async () => {
  eq(await classifyCaller('Bearer cron-secre', deps()), null, 'prefix')
  eq(await classifyCaller('Bearer cron-secrets', deps()), null, 'extra char')
  eq(safeEqual('abc', 'abd'), false, 'safeEqual differs')
  eq(safeEqual('abc', 'abc'), true, 'safeEqual same')
})

Deno.test('sender: default is licenses (existing callers unchanged); contracts is server-only; unknown is rejected', () => {
  const lic = resolveSender(undefined)!
  eq(lic.from, 'License Manager <license_manager@em.sil.org>', 'default from')
  eq(lic.replyTo, 'helpdesk+licenses@sil.org', 'default reply-to')
  eq(lic.serverOnly, false, 'licenses open to browser')
  eq(resolveSender('licenses')!.from, lic.from, 'explicit licenses')
  const c = resolveSender('contracts', { contractsReplyTo: 'contracts@sil.org' })!
  eq(c.from, 'Contract Repository <contracts@em.sil.org>', 'contracts from')
  eq(c.serverOnly, true, 'contracts server-only')
  eq(resolveSender('someone@evil.com'), null, 'arbitrary app')
  eq(resolveSender({ from: 'x' }), null, 'object app')
})

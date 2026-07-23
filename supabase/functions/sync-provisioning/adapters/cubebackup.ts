// CubeBackup adapter — resolves desired emails to CubeBackup's opaque
// internal user Ids (its batch endpoint doesn't accept emails directly),
// then diffs against each user's current backup status.
//
// config shape: { "baseUrl": "https://cubebackup.example.org", "domain": "sil.org" }
//   baseUrl: the self-hosted CubeBackup server's base URL
//   domain:  the Google Workspace domain as registered in CubeBackup
//
// Auth: `Authorization: {CUBEBACKUP_API_KEY}` — the raw key, not a Bearer
// token (confirmed from CubeBackup's docs). The key is scoped to the whole
// CubeBackup server instance, not per-domain.

interface CubeBackupUser {
  Id: string
  PrimaryEmail: string
  [key: string]: unknown
}

interface SyncResult {
  enabled: string[]
  disabled: string[]
  errors: { email: string; message: string }[]
}

export async function cubebackupSync(config: any, desiredEmails: string[]): Promise<SyncResult> {
  const apiKey = Deno.env.get('CUBEBACKUP_API_KEY')
  if (!apiKey) throw new Error('CUBEBACKUP_API_KEY is not set')
  const { baseUrl, domain } = config || {}
  if (!baseUrl || !domain) throw new Error("cubebackup provisioning_config requires 'baseUrl' and 'domain'")

  const desiredSet = new Set(desiredEmails.map(e => e.toLowerCase()))

  let byEmail = indexByEmail(await listUsers(baseUrl, domain, apiKey))
  const missing = desiredEmails.filter(e => !byEmail.has(e.toLowerCase()))
  if (missing.length) {
    // Covers a newly-provisioned Google user CubeBackup hasn't picked up yet.
    await triggerUserSync(baseUrl, domain, apiKey)
    byEmail = indexByEmail(await listUsers(baseUrl, domain, apiKey))
  }

  const enabledIds: string[] = []
  const disabledIds: string[] = []
  const enabled: string[] = []
  const disabled: string[] = []
  const errors: { email: string; message: string }[] = []

  for (const user of byEmail.values()) {
    const email = user.PrimaryEmail.toLowerCase()
    const shouldBackup = desiredSet.has(email)
    const currentlyBackedUp = isBackupEnabled(user)
    if (shouldBackup && !currentlyBackedUp) {
      enabledIds.push(user.Id)
      enabled.push(email)
    } else if (!shouldBackup && currentlyBackedUp) {
      disabledIds.push(user.Id)
      disabled.push(email)
    }
  }

  for (const email of desiredEmails) {
    if (!byEmail.has(email.toLowerCase())) {
      errors.push({ email, message: 'not found in CubeBackup after users/sync' })
    }
  }

  if (enabledIds.length || disabledIds.length) {
    const res = await fetch(`${baseUrl}/api/v1/domains/${encodeURIComponent(domain)}/users/batch-update-backup-status`, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ EnabledUserIds: enabledIds, DisabledUserIds: disabledIds }),
    })
    if (!res.ok) throw new Error(`batch-update-backup-status failed: ${res.status} ${await res.text()}`)
  }

  return { enabled, disabled, errors }
}

async function listUsers(baseUrl: string, domain: string, apiKey: string): Promise<CubeBackupUser[]> {
  const res = await fetch(`${baseUrl}/api/v1/domains/${encodeURIComponent(domain)}/users`, {
    headers: { Authorization: apiKey },
  })
  if (!res.ok) throw new Error(`list users failed: ${res.status} ${await res.text()}`)
  return await res.json()
}

async function triggerUserSync(baseUrl: string, domain: string, apiKey: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/v1/domains/${encodeURIComponent(domain)}/users/sync`, {
    method: 'POST',
    headers: { Authorization: apiKey },
  })
  if (!res.ok) throw new Error(`users/sync failed: ${res.status} ${await res.text()}`)
}

function indexByEmail(users: CubeBackupUser[]): Map<string, CubeBackupUser> {
  const map = new Map<string, CubeBackupUser>()
  for (const u of users || []) {
    if (u.PrimaryEmail) map.set(u.PrimaryEmail.toLowerCase(), u)
  }
  return map
}

// TODO(verify before relying on this in production): CubeBackup's public API
// reference doesn't document the exact field name for "is this user
// currently backed up" — `Id` and `PrimaryEmail` are confirmed, this isn't.
// Inspect a real GET /domains/{domain}/users response on the actual instance
// and correct this field name before the first live sync.
function isBackupEnabled(user: CubeBackupUser): boolean {
  return Boolean(user.BackupEnabled)
}

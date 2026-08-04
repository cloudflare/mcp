import { OAuthError } from './workers-oauth-utils'

const ADMISSION_PREFIX = 'oauth:refresh-admission:v1'
const ADMISSION_WINDOW_MS = 90_000
const ADMISSION_TTL_SECONDS = 120
const CLAIM_SETTLE_MS = 100

const localBlocks = new Map<string, number>()

/** Clear isolate-local admission state between workerd tests. */
export function clearRefreshAdmissionsForTesting(): void {
  localBlocks.clear()
}

type AdmissionRecord = {
  owner: string
  blockedUntil: number
}

function admissionKey(userId: string, grantId: string): string {
  return `${ADMISSION_PREFIX}:${userId}:${grantId}`
}

function retryAfter(blockedUntil: number): string {
  return String(Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000)))
}

function rejectAdmission(blockedUntil: number): never {
  throw new OAuthError(
    'temporarily_unavailable',
    'Token refresh is already in progress; retry shortly',
    429,
    { 'Retry-After': retryAfter(blockedUntil) }
  )
}

function isTerminalRefreshError(error: unknown): boolean {
  return (
    error instanceof OAuthError &&
    ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(error.code)
  )
}

async function readAdmission(kv: KVNamespace, key: string): Promise<AdmissionRecord | null> {
  try {
    const value = await kv.get(key, 'json')
    if (!value || typeof value !== 'object') return null
    const { owner, blockedUntil } = value as Partial<AdmissionRecord>
    if (typeof owner !== 'string' || typeof blockedUntil !== 'number') return null
    return { owner, blockedUntil }
  } catch (error) {
    console.warn('Refresh admission: failed to read KV claim', error)
    return null
  }
}

async function releaseAdmission(kv: KVNamespace, key: string, owner: string): Promise<void> {
  localBlocks.delete(key)
  try {
    const current = await readAdmission(kv, key)
    if (current?.owner === owner) await kv.delete(key)
  } catch (error) {
    console.warn('Refresh admission: failed to release KV claim', error)
  }
}

/**
 * Best-effort cross-isolate admission gate for one downstream OAuth grant.
 *
 * KV is eventually consistent, so this cannot be a strict mutex. The owner
 * write/read-back narrows the race, while the isolate-local map deterministically
 * rejects duplicate work in one isolate. Successful refreshes retain a tombstone
 * so retries with either the current or previous downstream token cannot trigger
 * another rotation during Cloudflare OAuth's concurrency grace period.
 */
export async function withRefreshAdmission<T>(
  kv: KVNamespace,
  grant: { userId: string; grantId: string },
  refresh: () => Promise<T>
): Promise<T> {
  const key = admissionKey(grant.userId, grant.grantId)
  const now = Date.now()
  const localBlockedUntil = localBlocks.get(key)
  if (localBlockedUntil && localBlockedUntil > now) rejectAdmission(localBlockedUntil)
  if (localBlockedUntil) localBlocks.delete(key)

  // Claim locally before the first await so concurrent requests in this isolate
  // cannot all pass the initial KV read.
  const blockedUntil = now + ADMISSION_WINDOW_MS
  localBlocks.set(key, blockedUntil)

  const owner = crypto.randomUUID()
  const existing = await readAdmission(kv, key)
  if (existing && existing.blockedUntil > Date.now()) {
    localBlocks.set(key, existing.blockedUntil)
    rejectAdmission(existing.blockedUntil)
  }

  try {
    await kv.put(key, JSON.stringify({ owner, blockedUntil } satisfies AdmissionRecord), {
      expirationTtl: ADMISSION_TTL_SECONDS
    })
  } catch (error) {
    localBlocks.delete(key)
    console.warn('Refresh admission: failed to write KV claim', error)
    rejectAdmission(Date.now() + 30_000)
  }

  await new Promise((resolve) => setTimeout(resolve, CLAIM_SETTLE_MS))
  const settled = await readAdmission(kv, key)
  if (settled?.owner !== owner || settled.blockedUntil <= Date.now()) {
    localBlocks.set(key, settled?.blockedUntil ?? blockedUntil)
    rejectAdmission(settled?.blockedUntil ?? blockedUntil)
  }

  try {
    return await refresh()
  } catch (error) {
    if (!isTerminalRefreshError(error)) await releaseAdmission(kv, key, owner)
    throw error
  }
}

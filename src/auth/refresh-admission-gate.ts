import { z } from 'zod'

import { OAuthError } from './workers-oauth-utils'

const ADMISSION_PREFIX = 'oauth:refresh-admission:v1'
// Collapse the concurrent request burst without consuming Cloudflare OAuth's
// 90-second upstream retry grace. If provider persistence fails after the
// callback succeeds, the client can retry while that upstream token is valid.
const ADMISSION_WINDOW_MS = 10_000
const ADMISSION_TTL_SECONDS = 60
const CLAIM_SETTLE_MS = 100

const localBlocks = new Map<string, number>()

const AdmissionRecord = z.object({
  owner: z.string().min(1),
  blockedUntil: z.number().finite()
})

type AdmissionRecord = z.infer<typeof AdmissionRecord>

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

async function readAdmission(kv: KVNamespace, key: string): Promise<AdmissionRecord | null> {
  try {
    const parsed = AdmissionRecord.safeParse(await kv.get(key, 'json'))
    return parsed.success ? parsed.data : null
  } catch (error) {
    console.warn('Refresh admission: failed to read KV claim', error)
    return null
  }
}

async function releaseAdmission(kv: KVNamespace, key: string, owner: string): Promise<void> {
  localBlocks.delete(key)
  const current = await readAdmission(kv, key)
  if (current?.owner !== owner) return
  try {
    await kv.delete(key)
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
    // The callback did not produce credentials, so no downstream rotation can
    // follow. Release every failure; terminal invalid_grant revocation belongs
    // to the caller that owns the downstream grant lifecycle.
    await releaseAdmission(kv, key, owner)
    throw error
  }
}

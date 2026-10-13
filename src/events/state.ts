import { getOAuthApi } from '@cloudflare/workers-oauth-provider'
import { z } from 'zod'
import { UnsubscribeParams } from './ans-bridge'

export interface EventEnvironment {
  OAUTH_KV: KVNamespace
  MCP_COOKIE_ENCRYPTION_KEY: string
  CLOUDFLARE_API_BASE: string
  MCP_RESOURCE: string
}

const SubscriptionIdSchema = z.string().regex(/^sub_[a-f0-9]{64}$/)

/** SHA-256 of a signing secret, hex. Lets us compare secrets without keeping them. */
const SecretHash = z.string().regex(/^[a-f0-9]{64}$/)

/**
 * Hash a webhook signing secret so it can be compared on refresh without being
 * stored.
 */
export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Subscription metadata kept, encrypted, in the ANS policy description. It
 * identifies the owner and the subscription key, and holds only a hash of the
 * signing secret.
 */
const CurrentPolicyState = z.object({
  version: z.literal(2),
  id: SubscriptionIdSchema,
  principal: z.string(),
  params: UnsubscribeParams,
  signingSecretHash: SecretHash,
  webhookId: z.string(),
  expiresAt: z.number(),
  verifiedUntil: z.number()
})

/** Subscription metadata from the ANS policy description. */
export type PolicyState = z.infer<typeof CurrentPolicyState>

/** Parse policy state from its decrypted JSON. */
export function parsePolicyState(value: unknown): PolicyState {
  return CurrentPolicyState.parse(value)
}

/**
 * What the callback needs to forward alerts and cannot keep itself: where to
 * send them and the client's signing secret.
 *
 * It is sealed into the ANS destination's secret, never stored by this
 * server. ANS holds it (write-only through its API) and sends it back in
 * `cf-webhook-auth` with every alert, like workers-oauth-provider gets its
 * decryption key back from the client's token. Recovering a signing secret
 * needs both our encryption key and ANS's store.
 */
const DeliverySeal = z.object({
  id: SubscriptionIdSchema,
  callbackUrl: z.string().url(),
  signingSecret: z.string().startsWith('whsec_')
})
export type DeliverySeal = z.infer<typeof DeliverySeal>

/** Seal delivery details as the secret of a new ANS destination. */
export async function sealDeliverySecret(
  env: EventEnvironment,
  seal: DeliverySeal
): Promise<string> {
  return encryptState(env, `delivery-seal:${seal.id}`, seal)
}

/**
 * Open the secret ANS presented for a subscription. Opening it is the ingress
 * check: AES-GCM authenticates it, and it is bound to this subscription.
 *
 * @returns The delivery details, or `null` if the secret is not ours.
 */
export async function openDeliverySecret(
  env: EventEnvironment,
  id: string,
  secret: string
): Promise<DeliverySeal | null> {
  try {
    const seal = DeliverySeal.parse(await decryptState(env, `delivery-seal:${id}`, secret))
    return seal.id === id ? seal : null
  } catch {
    return null
  }
}

/**
 * A live subscription's routing and expiry, in OAUTH_KV. It holds no secret
 * and no credential. Its absence stops delivery: it expires with the
 * subscription and unsubscribe deletes it first.
 */
const SubscriptionRecord = z.object({
  id: SubscriptionIdSchema,
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  policyId: z.string().min(1),
  alertType: z.string().min(1),
  webhookId: z.string().min(1),
  signingSecretHash: SecretHash,
  expiresAt: z.number()
})
export type SubscriptionRecord = z.infer<typeof SubscriptionRecord>

const RECORD_PREFIX = 'mcp-events:subscription:'
/** KV's minimum TTL; also covers clock skew between refresh and expiry. */
const RECORD_GRACE_SECONDS = 60

/**
 * Store a subscription's record until it expires, replacing any previous one.
 *
 * @param now - Current time in Unix milliseconds.
 */
export async function writeSubscriptionRecord(
  env: EventEnvironment,
  record: SubscriptionRecord,
  now: number
): Promise<void> {
  const ttl = Math.ceil((record.expiresAt - now) / 1000) + RECORD_GRACE_SECONDS
  await env.OAUTH_KV.put(`${RECORD_PREFIX}${record.id}`, JSON.stringify(record), {
    expirationTtl: Math.max(ttl, RECORD_GRACE_SECONDS)
  })
}

/**
 * Read a subscription's record.
 *
 * @returns The record, or `null` when there is none (never created, expired,
 * unsubscribed) or it does not parse.
 */
export async function readSubscriptionRecord(
  env: EventEnvironment,
  id: string
): Promise<SubscriptionRecord | null> {
  const stored = await env.OAUTH_KV.get(`${RECORD_PREFIX}${id}`, 'json')
  const record = SubscriptionRecord.safeParse(stored)
  return record.success && record.data.id === id ? record.data : null
}

/** Delete a subscription's record so delivery stops. */
export async function deleteSubscriptionRecord(env: EventEnvironment, id: string): Promise<void> {
  await env.OAUTH_KV.delete(`${RECORD_PREFIX}${id}`)
}

function oauth(env: EventEnvironment) {
  return getOAuthApi(
    {
      apiRoute: '/mcp',
      apiHandler: { fetch: () => new Response(null, { status: 404 }) },
      defaultHandler: { fetch: () => new Response(null, { status: 404 }) },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      resourceMetadata: { resource: env.MCP_RESOURCE }
    },
    env
  )
}

export async function credentialInfo(env: EventEnvironment, bearer: string) {
  const token = await oauth(env).unwrapToken(bearer)
  return { providerIssued: token !== null, expiresAt: token ? token.expiresAt * 1000 : Infinity }
}

async function key(env: EventEnvironment) {
  if (env.MCP_COOKIE_ENCRYPTION_KEY.length < 32)
    throw new Error('MCP_COOKIE_ENCRYPTION_KEY must be at least 32 characters')
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`mcp-events:v1:${env.MCP_COOKIE_ENCRYPTION_KEY}`)
  )
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptState(
  env: EventEnvironment,
  purpose: string,
  value: unknown
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: new TextEncoder().encode(`${env.MCP_RESOURCE}:${purpose}`)
    },
    await key(env),
    new TextEncoder().encode(JSON.stringify(value))
  )
  const bytes = new Uint8Array(12 + ciphertext.byteLength)
  bytes.set(nonce)
  bytes.set(new Uint8Array(ciphertext), 12)
  const result = `mcp-events-v1:${btoa(String.fromCharCode(...bytes))}`
  if (result.length > 16_384) throw new Error('Event state exceeds size limit')
  return result
}

export async function decryptState(
  env: EventEnvironment,
  purpose: string,
  value: string
): Promise<unknown> {
  if (!value.startsWith('mcp-events-v1:') || value.length > 16_384)
    throw new Error('Invalid event state')
  const bytes = Uint8Array.from(atob(value.slice('mcp-events-v1:'.length)), (character) =>
    character.charCodeAt(0)
  )
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bytes.slice(0, 12),
      additionalData: new TextEncoder().encode(`${env.MCP_RESOURCE}:${purpose}`)
    },
    await key(env),
    bytes.slice(12)
  )
  return JSON.parse(new TextDecoder().decode(plaintext))
}

import { getOAuthApi } from '@cloudflare/workers-oauth-provider'
import { z } from 'zod'
import { SubscribeParams } from './ans-bridge'

export interface EventEnvironment {
  OAUTH_KV: KVNamespace
  MCP_COOKIE_ENCRYPTION_KEY: string
  CLOUDFLARE_API_BASE: string
  MCP_RESOURCE: string
}

export const PolicyState = z.object({
  version: z.literal(1),
  id: z.string().regex(/^sub_[a-f0-9]{64}$/),
  principal: z.string(),
  params: SubscribeParams,
  webhookId: z.string().min(1),
  expiresAt: z.number(),
  verifiedUntil: z.number(),
  previousSigningSecret: z.string().optional(),
  previousSecretExpiresAt: z.number().optional()
})
export type PolicyState = z.infer<typeof PolicyState>

/**
 * What a callback needs to forward one subscription's alerts: where to send
 * them, how to sign them, and until when. It holds no user credential. Like
 * workers-oauth-provider, the server never keeps a token it can use without
 * the client presenting it; access is re-checked on each subscribe/refresh.
 *
 * Kept in KV, not in the ANS destination secret: ANS keeps a destination's
 * secret from creation and ignores updates, while the expiry and signing key
 * change on refresh.
 */
export const DeliveryTicket = z.object({
  id: z.string().regex(/^sub_[a-f0-9]{64}$/),
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  policyId: z.string().min(1),
  alertType: z.string().min(1),
  callbackUrl: z.string().url(),
  signingSecret: z.string().startsWith('whsec_'),
  previousSigningSecret: z.string().startsWith('whsec_').optional(),
  previousSecretExpiresAt: z.number().optional(),
  expiresAt: z.number()
})
export type DeliveryTicket = z.infer<typeof DeliveryTicket>

const TICKET_PREFIX = 'mcp-events:ticket:'
/** KV's minimum TTL; also covers clock skew between refresh and expiry. */
const TICKET_GRACE_SECONDS = 60

/**
 * Store a subscription's delivery ticket, encrypted, until it expires.
 *
 * @param env - Bindings holding OAUTH_KV and the encryption key.
 * @param ticket - The ticket to store; replaces any previous one.
 * @param now - Current time in Unix milliseconds.
 */
export async function writeDeliveryTicket(
  env: EventEnvironment,
  ticket: DeliveryTicket,
  now: number
): Promise<void> {
  const ttl = Math.ceil((ticket.expiresAt - now) / 1000) + TICKET_GRACE_SECONDS
  await env.OAUTH_KV.put(
    `${TICKET_PREFIX}${ticket.id}`,
    await encryptState(env, `delivery:${ticket.id}`, ticket),
    { expirationTtl: Math.max(ttl, TICKET_GRACE_SECONDS) }
  )
}

/**
 * Read a subscription's delivery ticket.
 *
 * @returns The ticket, or `null` when none is stored (never created, expired
 * or unsubscribed).
 */
export async function readDeliveryTicket(
  env: EventEnvironment,
  id: string
): Promise<DeliveryTicket | null> {
  const stored = await env.OAUTH_KV.get(`${TICKET_PREFIX}${id}`)
  if (stored === null) return null
  const ticket = DeliveryTicket.parse(await decryptState(env, `delivery:${id}`, stored))
  if (ticket.id !== id) throw new Error('Delivery ticket identity mismatch')
  return ticket
}

/** Delete a subscription's delivery ticket so its callbacks stop forwarding. */
export async function deleteDeliveryTicket(env: EventEnvironment, id: string): Promise<void> {
  await env.OAUTH_KV.delete(`${TICKET_PREFIX}${id}`)
}

/**
 * The secret ANS sends in `cf-webhook-auth` for one subscription's destination.
 *
 * It never changes for a subscription, so it survives ANS ignoring secret
 * updates. It only proves the caller is ANS for this subscription; the
 * credential to act on lives in the delivery ticket.
 */
export async function ingressSecret(env: EventEnvironment, id: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`mcp-events:ingress:v1:${env.MCP_COOKIE_ENCRYPTION_KEY}`)
    ),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${env.MCP_RESOURCE}:${id}`)
  )
  return `mcp-events-ingress-v1:${btoa(String.fromCharCode(...new Uint8Array(mac)))}`
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

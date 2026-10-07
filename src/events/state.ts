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

export const DeliveryTicket = z.object({
  id: z.string().regex(/^sub_[a-f0-9]{64}$/),
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  bearer: z.string().min(1),
  providerIssued: z.boolean(),
  expiresAt: z.number(),
  policyId: z.string().min(1).optional()
})
export type DeliveryTicket = z.infer<typeof DeliveryTicket>

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

export async function deliveryAccessToken(
  env: EventEnvironment,
  ticket: DeliveryTicket
): Promise<string | null> {
  if (!ticket.providerIssued) return ticket.bearer
  const token = await oauth(env).unwrapToken(ticket.bearer)
  if (!token || token.expiresAt * 1000 <= Date.now()) return null
  return z.object({ accessToken: z.string().min(1) }).parse(token.grant.props).accessToken
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

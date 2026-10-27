import { z } from 'zod'

import { AccountSchema } from '../types'

/**
 * Enterprise-Managed Authorization tenants: one per Cloudflare account whose admin registered an
 * IdP with this server, stored in `OAUTH_KV`.
 *
 * - `ema-tenant:{accountId}`: the tenant record, with its account token encrypted.
 * - `ema-issuer:{sha256(issuer)}:{accountId}`: one marker per tenant that trusts an issuer, so a
 *   token request finds the issuer's tenants with one list.
 * - `ema-user:{accountId}:{userId}`: one marker per user ID that got a token, so disabling the
 *   tenant can revoke every grant it minted. Each expires with the token.
 *
 * KV is eventually consistent: a change can take up to a minute to reach every location.
 */

const TENANT_PREFIX = 'ema-tenant:'
const ISSUER_PREFIX = 'ema-issuer:'
const USER_PREFIX = 'ema-user:'

export const EncryptedSecretSchema = z.object({
  iv: z.string().min(1),
  ciphertext: z.string().min(1)
})

export type EncryptedSecret = z.infer<typeof EncryptedSecretSchema>

export const EmaTenantSchema = z.object({
  account: AccountSchema,
  status: z.enum(['active', 'disabled']),
  /** Exact `iss` the tenant's ID-JAGs carry. */
  issuer: z.string().url(),
  /** Discovered from the issuer's metadata, never typed in by the admin. */
  jwksUri: z.string().url(),
  algorithms: z.array(z.enum(['RS256', 'ES256'])).min(1),
  /** Clients whose ID-JAGs this tenant accepts: its own client plus any the admin added. */
  clientIds: z.array(z.string().min(1)).min(1),
  /** The client this server created for the tenant at registration. */
  tenantClientId: z.string().min(1),
  /** When non-empty, the ID-JAG's `email` must be under one of these domains. */
  emailDomains: z.array(z.string().min(1)),
  /** The account API token every MCP token for this tenant acts with. */
  credential: EncryptedSecretSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int()
})

export type EmaTenant = z.infer<typeof EmaTenantSchema>

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function issuerPrefix(issuer: string): Promise<string> {
  return `${ISSUER_PREFIX}${await sha256Hex(issuer)}:`
}

/** Read one tenant, or `null` when the account has none (or the record no longer parses). */
export async function getTenant(kv: KVNamespace, accountId: string): Promise<EmaTenant | null> {
  const raw = await kv.get(`${TENANT_PREFIX}${accountId}`, 'json')
  const parsed = EmaTenantSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Store a tenant and its issuer marker, replacing the marker for a previous issuer. */
export async function putTenant(
  kv: KVNamespace,
  tenant: EmaTenant,
  previousIssuer?: string
): Promise<void> {
  const accountId = tenant.account.id
  await kv.put(`${TENANT_PREFIX}${accountId}`, JSON.stringify(tenant))
  await kv.put(`${await issuerPrefix(tenant.issuer)}${accountId}`, '')
  if (previousIssuer && previousIssuer !== tenant.issuer) {
    await kv.delete(`${await issuerPrefix(previousIssuer)}${accountId}`)
  }
}

/** Delete a tenant and its issuer marker. User markers expire on their own. */
export async function deleteTenant(kv: KVNamespace, tenant: EmaTenant): Promise<void> {
  await kv.delete(`${await issuerPrefix(tenant.issuer)}${tenant.account.id}`)
  await kv.delete(`${TENANT_PREFIX}${tenant.account.id}`)
}

/**
 * Every active tenant that trusts `issuer`. A tenant whose record says a different issuer (its
 * marker is stale after an edit) is left out.
 */
export async function tenantsForIssuer(kv: KVNamespace, issuer: string): Promise<EmaTenant[]> {
  const prefix = await issuerPrefix(issuer)
  const listed = await kv.list({ prefix, limit: 100 })
  const tenants = await Promise.all(
    listed.keys.map((key) => getTenant(kv, key.name.slice(prefix.length)))
  )
  return tenants.filter(
    (tenant): tenant is EmaTenant =>
      tenant !== null && tenant.status === 'active' && tenant.issuer === issuer
  )
}

/** Remember that `userId` holds a grant minted for the tenant, until the token expires. */
export async function recordTenantUser(
  kv: KVNamespace,
  accountId: string,
  userId: string,
  ttlSeconds: number
): Promise<void> {
  // KV refuses an expirationTtl under 60 seconds.
  await kv.put(`${USER_PREFIX}${accountId}:${userId}`, '', {
    expirationTtl: Math.max(60, ttlSeconds + 60)
  })
}

/** The user IDs that may still hold grants minted for the tenant. */
export async function tenantUsers(kv: KVNamespace, accountId: string): Promise<string[]> {
  const prefix = `${USER_PREFIX}${accountId}:`
  const users: string[] = []
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix, cursor })
    users.push(...page.keys.map((key) => key.name.slice(prefix.length)))
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return users
}

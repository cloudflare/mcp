import { z } from 'zod'
import { DERIVED_OAUTH_SCOPES } from './auth/derived-oauth-scopes'

/**
 * Which credential a request carries, as far as Cloudflare permissions go.
 *
 * - `oauth`: a token this server issued. Its scopes are the ones Cloudflare
 *   granted the connection.
 * - `direct`: a Cloudflare API token or OAuth token passed straight through.
 *   Its permissions are unknown here.
 */
export type Connection =
  | { readonly kind: 'oauth'; readonly scopes: readonly string[] }
  | { readonly kind: 'direct' }

/** A credential whose permissions this server doesn't know. */
export const DIRECT_CONNECTION: Connection = { kind: 'direct' }

// workers-oauth-provider reports a client and scopes only for the tokens it
// issued; for an externally resolved credential it reports neither.
const IssuedTokenAuth = z.object({ clientId: z.string().min(1), scope: z.array(z.string()) })

/**
 * Parse the provider's `ctx.auth` into a {@link Connection}.
 *
 * @param auth - `ctx.auth` from workers-oauth-provider, or nothing.
 * @returns `oauth` with the granted scopes for a provider-issued token, else `direct`.
 */
export function connectionFromAuth(auth: unknown): Connection {
  const issued = IssuedTokenAuth.safeParse(auth)
  return issued.success ? { kind: 'oauth', scopes: issued.data.scope } : DIRECT_CONNECTION
}

const PermissionLabels = z.array(z.string().min(1)).min(1)

/**
 * The API token permissions an operation accepts, from its `x-api-token-group`.
 * Any one of them is enough.
 *
 * @param operation - The operation, or anything carrying its `x-api-token-group`.
 * @returns The permission names, or `undefined` when the spec lists none.
 */
export function acceptedPermissions(
  operation: { readonly 'x-api-token-group'?: unknown } | undefined
): string[] | undefined {
  const labels = PermissionLabels.safeParse(operation?.['x-api-token-group'])
  return labels.success ? [...new Set(labels.data)] : undefined
}

const SCOPE_NAMES: ReadonlyMap<string, string> = new Map(
  Object.entries(DERIVED_OAUTH_SCOPES).map(([scope, { name }]) => [scope, name])
)

/**
 * Whether `scope` is in the production OAuth scope catalog.
 *
 * @param scope - A scope ID.
 * @returns `true` for a catalog scope.
 */
export function isCatalogScope(scope: string): boolean {
  return SCOPE_NAMES.has(scope)
}

/** OAuth scope IDs by permission name. OAuth scopes share API token permission names. */
const SCOPES_BY_PERMISSION: ReadonlyMap<string, readonly string[]> = (() => {
  const scopes = new Map<string, string[]>()
  for (const [scope, name] of SCOPE_NAMES) scopes.set(name, [...(scopes.get(name) ?? []), scope])
  return scopes
})()

/**
 * Find the spec operation a request was sent to.
 *
 * @param paths - Operations by path template and lower-case method.
 * @param method - The request method.
 * @param path - The request path below the API base, such as `/zones/abc/dns_records`.
 * @returns The template and operation that match with the most literal segments.
 */
export function findOperation<Operation>(
  paths: Record<string, Record<string, Operation>>,
  method: string,
  path: string
): { template: string; operation: Operation } | undefined {
  const segments = path.replace(/\/+$/, '').split('/')
  const verb = method.toLowerCase()
  let best: { template: string; operation: Operation; literals: number } | undefined
  for (const [template, item] of Object.entries(paths)) {
    const operation = item[verb]
    if (!operation) continue
    const parts = template.split('/')
    if (parts.length !== segments.length) continue
    let literals = 0
    const matches = parts.every((part, index) => {
      if (/^\{[^}]+\}$/.test(part)) return segments[index] !== ''
      literals++
      return part === segments[index]
    })
    if (matches && (!best || literals > best.literals)) best = { template, operation, literals }
  }
  return best && { template: best.template, operation: best.operation }
}

const MAX_LISTED = 8

function list(items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED).join(', ')
  return items.length > MAX_LISTED ? `${shown} and ${items.length - MAX_LISTED} more` : shown
}

function scopeLabel(scope: string): string {
  const name = SCOPE_NAMES.get(scope)
  return name ? `\`${scope}\` (${name})` : `\`${scope}\``
}

/**
 * Explain why Cloudflare refused a request with 401 or 403, and what to do.
 *
 * Cloudflare reports a missing OAuth scope, an endpoint OAuth can't reach, and
 * a missing role all as `10000: Authentication error` or `9109: Unauthorized`.
 * That reads like a signed-out connection, so agents ask users to reconnect,
 * which changes nothing. This tells the cases apart.
 *
 * @param status - The HTTP status Cloudflare returned.
 * @param connection - The credential that made the request.
 * @param permissions - What the endpoint accepts, from {@link acceptedPermissions}.
 * @returns Guidance for the agent, or `undefined` for other statuses.
 */
export function explainRefusal(
  status: number,
  connection: Connection,
  permissions: readonly string[] | undefined
): string | undefined {
  if (status === 401) {
    return connection.kind === 'oauth'
      ? 'Cloudflare did not accept this connection’s credentials. Reconnect to sign in again.'
      : 'Cloudflare did not accept this credential. Check that the API token is valid and has not expired.'
  }
  if (status !== 403) return undefined

  if (!permissions) {
    return 'The API spec lists no permissions for this endpoint. HTTP 403 means the credential was accepted but is not allowed to do this, so reconnecting with the same permissions will not help. Check the endpoint’s documentation.'
  }

  const scopes = [...new Set(permissions.flatMap((name) => SCOPES_BY_PERMISSION.get(name) ?? []))]

  if (connection.kind === 'direct') {
    const named = permissions.map((name) => {
      const ids = SCOPES_BY_PERMISSION.get(name)
      return ids ? `${name} (${ids.map((id) => `\`${id}\``).join(' or ')})` : name
    })
    return `This endpoint needs one of these permissions: ${list(named)}. Add one to the token.`
  }

  if (scopes.length === 0) {
    return `No OAuth scope covers this endpoint, so OAuth connections cannot use it. Connect with an API token that has one of these permissions instead: ${list(permissions)}.`
  }

  const held = scopes.filter((scope) => connection.scopes.includes(scope))
  if (held.length > 0) {
    return `This connection already has ${list(held.map(scopeLabel))}, which this endpoint accepts, so reconnecting will not help. Cloudflare refused for another reason: usually the user’s role on the account or zone, or a resource in an account this connection was not granted.`
  }

  return `This connection was not granted a scope this endpoint accepts. Reconnect and grant one of: ${list(scopes.map(scopeLabel))}.`
}

const SAFE_METHODS = new Set(['GET', 'HEAD'])

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word && !['read', 'write', 'revoke', 'edit'].includes(word))
  )
}

/**
 * The one OAuth scope to challenge for after Cloudflare refused a request that
 * an OAuth connection lacked every accepted scope for.
 *
 * Any scope the endpoint accepts satisfies it, so the choice only decides what
 * the user is asked to grant: read scopes for GET/HEAD and write scopes
 * otherwise, the account or zone variant that matches the path, then the scope
 * whose name shares the most words with the path. A tie names no scope; the
 * refusal explanation lists the options instead.
 *
 * @param status - The HTTP status Cloudflare returned.
 * @param connection - The credential that made the request.
 * @param method - The request method.
 * @param path - The request path or template below the API base.
 * @param permissions - What the endpoint accepts, from {@link acceptedPermissions}.
 * @returns The scope to request, or `undefined` when a challenge wouldn't help.
 */
export function scopeToRequest(
  status: number,
  connection: Connection,
  method: string,
  path: string,
  permissions: readonly string[] | undefined
): string | undefined {
  if (status !== 403 || connection.kind !== 'oauth' || !permissions) return undefined

  const [own, other] =
    path.split('/')[1] === 'zones' ? ['zone-', 'account-'] : ['account-', 'zone-']
  const candidates = new Set<string>()
  for (const permission of permissions) {
    const scopes = SCOPES_BY_PERMISSION.get(permission) ?? []
    // One permission name can be both an account and a zone scope (`access.read` and
    // `zone-access.read`, `account-logs.read` and `logs.read`): keep the path's variant.
    const prefixed = scopes.filter((scope) => scope.startsWith(own))
    const variant = prefixed.length > 0 ? prefixed : scopes.filter((s) => !s.startsWith(other))
    for (const scope of variant.length === 1 ? variant : scopes) candidates.add(scope)
  }
  if ([...candidates].some((scope) => connection.scopes.includes(scope))) return undefined

  const reads = SAFE_METHODS.has(method.toUpperCase())
  const preferred = [...candidates].filter((scope) => scope.endsWith('.read') === reads)
  const pool = (preferred.length > 0 ? preferred : [...candidates]).sort()
  if (pool.length <= 1) return pool[0]

  const pathWords = words(path.replace(/\{[^}]+\}/g, ''))
  const ranked = pool
    .map((scope) => ({ scope, overlap: [...words(scope)].filter((w) => pathWords.has(w)).length }))
    .sort((a, b) => b.overlap - a.overlap)
  return ranked[0].overlap > ranked[1].overlap ? ranked[0].scope : undefined
}

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

/** The OpenAPI security scheme the spec lists Cloudflare OAuth scopes under. */
export const OAUTH_SECURITY_SCHEME = 'cloudflare_oauth'

const SecurityRequirements = z.array(z.record(z.string(), z.array(z.string())))

/**
 * The OAuth scopes an operation accepts, from its `security` requirements.
 * Each requirement names one scope; any one is enough.
 *
 * @param operation - The operation, or anything carrying its `security`.
 * @returns The scope IDs, or `undefined` when the spec lists none.
 */
export function acceptedScopes(
  operation: { readonly security?: unknown } | undefined
): string[] | undefined {
  const requirements = SecurityRequirements.safeParse(operation?.security)
  if (!requirements.success) return undefined
  const scopes = new Set(
    requirements.data.flatMap((requirement) => requirement[OAUTH_SECURITY_SCHEME] ?? [])
  )
  return scopes.size > 0 ? [...scopes] : undefined
}

/** What an endpoint accepts: any one of its API token permissions, or any one of its OAuth scopes. */
export interface EndpointAccess {
  /** From `x-api-token-group`. */
  readonly permissions?: readonly string[]
  /** From `security`. */
  readonly scopes?: readonly string[]
}

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
 * Whether a connection may use an endpoint, as far as the spec and the
 * connection's OAuth scopes tell.
 *
 * - `unlisted`: the spec lists neither permissions nor scopes for the endpoint.
 * - `direct`: the credential's permissions are unknown here.
 * - `unreachable`: the spec lists permissions but no OAuth scope, so OAuth
 *   connections can't use the endpoint.
 * - `granted`: the connection holds a scope the endpoint accepts.
 * - `missing`: it holds none. `options` would each satisfy the endpoint;
 *   `scope` is the one to ask for, unless none stands out.
 */
export type Authorization =
  | { readonly kind: 'unlisted'; readonly connection: Connection['kind'] }
  | {
      readonly kind: 'direct'
      readonly permissions: readonly string[]
      readonly scopes: readonly string[]
    }
  | { readonly kind: 'unreachable'; readonly permissions: readonly string[] }
  | { readonly kind: 'granted'; readonly held: readonly string[] }
  | {
      readonly kind: 'missing'
      readonly options: readonly string[]
      readonly scope: string | undefined
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
 * The one scope to ask for: read scopes for GET/HEAD and write scopes
 * otherwise, then the scope whose name shares the most words with the path.
 * Any of them satisfies the endpoint, so this only decides what the user is
 * asked to grant. A tie names none.
 */
function scopeToAskFor(
  method: string,
  path: string,
  options: readonly string[]
): string | undefined {
  const reads = SAFE_METHODS.has(method.toUpperCase())
  const preferred = options.filter((scope) => scope.endsWith('.read') === reads)
  const pool = preferred.length > 0 ? preferred : [...options]
  if (pool.length <= 1) return pool[0]

  const pathWords = words(path.replace(/\{[^}]+\}/g, ''))
  const ranked = pool
    .map((scope) => ({ scope, overlap: [...words(scope)].filter((w) => pathWords.has(w)).length }))
    .sort((a, b) => b.overlap - a.overlap)
  return ranked[0].overlap > ranked[1].overlap ? ranked[0].scope : undefined
}

/** A request to a Cloudflare API endpoint. */
export interface EndpointRequest {
  /** The request method. */
  readonly method: string
  /** The request path below the API base, such as `/zones/abc/access/apps`. */
  readonly path: string
  /**
   * The endpoint's path template, such as `/zones/{zone_id}/access/apps`.
   * Defaults to `path` when the endpoint isn't known.
   */
  readonly template?: string
}

/**
 * Decide whether a connection may use an endpoint. The template picks the
 * scope to ask for by name, without IDs or resource names in the way.
 *
 * @param connection - The credential that made the request.
 * @param request - The method, request path and endpoint template.
 * @param access - What the endpoint accepts.
 * @returns The decision.
 */
export function authorize(
  connection: Connection,
  { method, path, template = path }: EndpointRequest,
  { permissions, scopes }: EndpointAccess = {}
): Authorization {
  if (!permissions && !scopes) return { kind: 'unlisted', connection: connection.kind }
  if (connection.kind === 'direct') {
    return { kind: 'direct', permissions: permissions ?? [], scopes: scopes ?? [] }
  }
  if (!scopes) return { kind: 'unreachable', permissions: permissions ?? [] }
  const held = scopes.filter((scope) => connection.scopes.includes(scope))
  if (held.length > 0) return { kind: 'granted', held }
  const options = [...scopes].sort()
  return { kind: 'missing', options, scope: scopeToAskFor(method, template, options) }
}

/** Whether Cloudflare refused the request. It answers a missing scope with 401 or 403, inconsistently. */
export function isRefusal(status: number): status is 401 | 403 {
  return status === 401 || status === 403
}

/**
 * Explain why Cloudflare refused a request with 401 or 403, and what to do.
 *
 * Cloudflare reports a missing OAuth scope, an endpoint OAuth can't reach, a
 * missing role and a rejected credential all as `10000: Authentication error`
 * or `9109: Unauthorized`, with either status (Workers KV and D1 writes get
 * 401 for a missing scope). That reads like a signed-out connection, so agents
 * ask users to reconnect, which usually changes nothing.
 *
 * So the {@link authorize} decision picks the explanation. The status matters
 * only when it can't: when the spec lists no permissions, and when the
 * connection already holds an accepted scope (401: Cloudflare rejected the
 * credential itself; 403: something else, usually the user's role).
 *
 * @param status - The HTTP status, 401 or 403.
 * @param authorization - The decision for the request, from {@link authorize}.
 * @returns Guidance for the agent.
 */
export function explainRefusal(status: 401 | 403, authorization: Authorization): string {
  switch (authorization.kind) {
    case 'unlisted':
      if (status === 401) {
        return authorization.connection === 'oauth'
          ? 'Cloudflare did not accept this connection’s credentials. Reconnect to sign in again.'
          : 'Cloudflare did not accept this credential. Check that the API token is valid and has not expired.'
      }
      return 'The API spec lists no permissions for this endpoint. HTTP 403 means the credential was accepted but is not allowed to do this, so reconnecting with the same permissions will not help. Check the endpoint’s documentation.'

    case 'direct': {
      const { permissions, scopes } = authorization
      const oauth =
        scopes.length > 0 ? ` (OAuth scopes: ${list(scopes.map((id) => `\`${id}\``))})` : ''
      const needs =
        permissions.length > 0
          ? `This endpoint needs one of these permissions: ${list(permissions)}${oauth}. Add one to the token.`
          : `This endpoint needs one of these OAuth scopes: ${list(scopes.map((id) => `\`${id}\``))}.`
      return status === 401
        ? `${needs} If the token already has one, check that it is valid and has not expired.`
        : needs
    }

    case 'unreachable':
      return `No OAuth scope covers this endpoint, so OAuth connections cannot use it. Connect with an API token that has one of these permissions instead: ${list(authorization.permissions)}.`

    case 'missing':
      return `This connection was not granted a scope this endpoint accepts. Reconnect and grant one of: ${list(authorization.options.map(scopeLabel))}.`

    case 'granted': {
      const has = `This connection already has ${list(authorization.held.map(scopeLabel))}, which this endpoint accepts`
      return status === 401
        ? `${has}, so Cloudflare rejected the credential itself. Reconnect to sign in again.`
        : `${has}, so reconnecting will not help. Cloudflare refused for another reason: usually the user’s role on the account or zone, or a resource in an account this connection was not granted.`
    }
  }
}

/**
 * Permissions that the baseline `user:read` and `account:read` scopes, which
 * sit outside the catalog, grant for some endpoints. Measured with a connection
 * holding only those: `/accounts/{account_id}/members` and `/roles` (Account
 * Settings Read), `/memberships` and `/user/invites` (Memberships Read), and
 * `/user` (User Details Read) all answer with data. Other endpoints accepting
 * the same permissions refuse, so these never count as held for a refusal.
 */
const SOMETIMES_BASELINE_PERMISSIONS: ReadonlySet<string> = new Set([
  'Account Settings Read',
  'Memberships Read',
  'User Details Read'
])

/**
 * Whether an empty list a GET returned may only mean that Cloudflare filtered
 * out everything the connection may not see.
 *
 * Cloudflare refuses some endpoints without the permission (D1, KV, R2) but
 * filters the lists of others to what the credential may see: `GET /zones` and
 * `GET /accounts/{account_id}/workers/scripts` without a scope for them answer
 * `200` with an empty `result`. Such a list says nothing about whether there
 * are any, so it is refused instead (see `src/api-refusals.ts`).
 *
 * A list with rows is never doubted, and nor is an endpoint the baseline scopes
 * may grant, so working calls are never refused.
 *
 * @param method - The request method.
 * @param authorization - The decision for the request, from {@link authorize}.
 * @param permissions - The API token permissions the endpoint accepts.
 * @returns `true` when an empty list proves nothing.
 */
export function emptyListProvesNothing(
  method: string,
  authorization: Authorization,
  permissions: readonly string[] | undefined
): boolean {
  return (
    method.toUpperCase() === 'GET' &&
    authorization.kind === 'missing' &&
    !permissions?.some((permission) => SOMETIMES_BASELINE_PERMISSIONS.has(permission))
  )
}

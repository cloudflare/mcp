import { z } from 'zod'
import { env } from 'cloudflare:workers'
import { canonicalPermission } from '../api-permissions'
import { hashApiToken } from './api-token-mode'
import snapshot from './member-role-permissions.json'
import type { AuthProps } from './types'

/**
 * The most a user's Cloudflare member roles let them do, so the direct tools
 * can leave out endpoints none of their roles reach. A connection's OAuth
 * scopes or API token permissions can be narrower; a step-up or a new token
 * gets them up to this, never past it.
 *
 * Roles come from `GET /memberships`, which the `user:read` scope every grant
 * holds can read. What each role reaches comes from
 * `member-role-permissions.json`, generated from IAM's role definitions by
 * `scripts/generate-member-permissions.ts`. Hiding a tool is only a
 * convenience, since Cloudflare still checks every call, so whatever isn't
 * known shows every tool: an account token, a user with a role the snapshot
 * lacks, more accounts than are read, or a failed request.
 */

/** Permissions the snapshot knows; tools accepting any other permission always show. */
const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(snapshot.permissions)
/** Indices into `snapshot.permissions` by role key (see {@link roleKey}). */
const ROLE_PERMISSIONS: Readonly<Record<string, readonly number[] | undefined>> = snapshot.roles

/** How long a token's roles are cached; a role change shows within this. */
export const MEMBER_ROLES_CACHE_TTL_SECONDS = 600
const MEMBERSHIPS_PAGE_SIZE = 50
/** Pages of `/memberships` read; a user with more accounts sees every tool. */
const MAX_MEMBERSHIP_PAGES = 4
const MEMBERSHIPS_TIMEOUT_MS = 3_000

const Memberships = z.object({
  result: z.array(
    z.object({
      status: z.string().optional(),
      roles: z.array(z.string()).optional(),
      policies: z
        .array(
          z.object({
            access: z.string().optional(),
            permission_groups: z.array(z.object({ name: z.string() })).optional()
          })
        )
        .optional()
    })
  ),
  result_info: z.object({ total_pages: z.number().optional() }).optional()
})

/** A cached lookup: the token's role names, or `null` when they can't be known. */
const CachedRoles = z.object({ roles: z.array(z.string()).nullable() })

const roleKeys = new Map<string, Promise<string>>()

/** The snapshot's key for a role name: the first 16 hex digits of its SHA-256. */
function roleKey(name: string): Promise<string> {
  let key = roleKeys.get(name)
  if (!key) {
    key = hashApiToken(name).then((hash) => hash.slice(0, 16))
    roleKeys.set(name, key)
  }
  return key
}

/**
 * The permissions a set of member roles reaches.
 *
 * @param roles - Role names, as `/memberships` reports them.
 * @returns The permission names, or `undefined` to show every tool: there are
 *   no roles, the snapshot lacks one, or together they reach everything.
 */
export async function permissionsForRoles(
  roles: readonly string[]
): Promise<ReadonlySet<string> | undefined> {
  if (roles.length === 0) return undefined
  const granted = new Set<string>()
  for (const role of roles) {
    const reached = ROLE_PERMISSIONS[await roleKey(role)]
    if (!reached) return undefined
    for (const index of reached) granted.add(snapshot.permissions[index])
  }
  return granted.size === KNOWN_PERMISSIONS.size ? undefined : granted
}

/**
 * Whether to list a tool.
 *
 * @param accepted - The API token permissions the tool's endpoint accepts.
 * @param granted - What the user's roles reach, from {@link memberPermissions}.
 * @returns `true` unless every permission the endpoint accepts is known and
 *   none is granted.
 */
export function toolVisible(
  accepted: readonly string[] | undefined,
  granted: ReadonlySet<string> | undefined
): boolean {
  if (!granted || !accepted || accepted.length === 0) return true
  return accepted.some((permission) => {
    const name = canonicalPermission(permission)
    return !KNOWN_PERMISSIONS.has(name) || granted.has(name)
  })
}

type RolesLookup = { kind: 'known'; roles: string[] | null } | { kind: 'failed' }

/** The role names on each accepted membership's allow policies. */
async function fetchRoles(token: string): Promise<RolesLookup> {
  const roles = new Set<string>()
  for (let page = 1; page <= MAX_MEMBERSHIP_PAGES; page++) {
    const url = new URL(`${env.CLOUDFLARE_API_BASE}/memberships`)
    url.searchParams.set('page', String(page))
    url.searchParams.set('per_page', String(MEMBERSHIPS_PAGE_SIZE))
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(MEMBERSHIPS_TIMEOUT_MS)
    })
    // A token without Memberships Read stays without it; ask again only after the TTL.
    if (response.status === 403) return { kind: 'known', roles: null }
    if (!response.ok) return { kind: 'failed' }
    const parsed = Memberships.safeParse(await response.json())
    if (!parsed.success) return { kind: 'failed' }

    for (const membership of parsed.data.result) {
      if (membership.status !== undefined && membership.status !== 'accepted') continue
      for (const role of membership.roles ?? []) roles.add(role)
      for (const policy of membership.policies ?? []) {
        if (policy.access !== undefined && policy.access !== 'allow') continue
        for (const group of policy.permission_groups ?? []) roles.add(group.name)
      }
    }

    const totalPages = parsed.data.result_info?.total_pages
    const last =
      totalPages === undefined
        ? parsed.data.result.length < MEMBERSHIPS_PAGE_SIZE
        : page >= totalPages
    if (last) return { kind: 'known', roles: [...roles].sort() }
  }
  return { kind: 'known', roles: null }
}

/** Roles held in memory too, so a client listing tools again and again skips KV. */
const MEMO_TTL_MS = 60_000
const MEMO_MAX_ENTRIES = 1_000
const memo = new Map<string, { roles: string[] | null; expiresAt: number }>()

function remember(tokenHash: string, roles: string[] | null): void {
  memo.delete(tokenHash)
  if (memo.size >= MEMO_MAX_ENTRIES) memo.delete(memo.keys().next().value!)
  memo.set(tokenHash, { roles, expiresAt: Date.now() + MEMO_TTL_MS })
}

/** Forget the roles held in memory. For tests. */
export function resetMemberRolesMemo(): void {
  memo.clear()
}

async function rolesFor(token: string): Promise<string[] | null> {
  const tokenHash = await hashApiToken(token)
  const held = memo.get(tokenHash)
  if (held && held.expiresAt > Date.now()) return held.roles

  const cacheKey = `member-roles:v1:${tokenHash}`
  try {
    const cached = CachedRoles.safeParse(await env.OAUTH_KV.get(cacheKey, 'json'))
    if (cached.success) {
      remember(tokenHash, cached.data.roles)
      return cached.data.roles
    }
  } catch (error) {
    console.warn('member_roles kv-cache read failed', error)
  }

  const lookup = await fetchRoles(token)
  if (lookup.kind === 'failed') return null
  remember(tokenHash, lookup.roles)
  try {
    await env.OAUTH_KV.put(cacheKey, JSON.stringify({ roles: lookup.roles }), {
      expirationTtl: MEMBER_ROLES_CACHE_TTL_SECONDS
    })
  } catch (error) {
    console.warn('member_roles kv-cache write failed', error)
  }
  return lookup.roles
}

/**
 * What the user's member roles reach, across all their accounts: tools take an
 * `account_id`, so a tool shows when any account would allow it.
 *
 * @param props - The connection's auth props.
 * @returns The permission names, or `undefined` to show every tool.
 */
export async function memberPermissions(
  props: AuthProps
): Promise<ReadonlySet<string> | undefined> {
  if (props.type !== 'user_token') return undefined
  try {
    const roles = await rolesFor(props.accessToken)
    return roles ? await permissionsForRoles(roles) : undefined
  } catch (error) {
    console.warn('member_roles lookup failed', error)
    return undefined
  }
}

/**
 * The tools to list, leaving out those the user's roles can't use.
 *
 * @param tools - Every tool, as `tools/list` sends them.
 * @param permissionsOf - The permissions a tool's endpoint accepts, by tool name.
 * @param granted - From {@link memberPermissions}; `undefined` keeps every tool.
 */
export function visibleTools<T extends { readonly name: string }>(
  tools: readonly T[],
  permissionsOf: (name: string) => readonly string[] | undefined,
  granted: ReadonlySet<string> | undefined
): readonly T[] {
  return granted ? tools.filter((tool) => toolVisible(permissionsOf(tool.name), granted)) : tools
}

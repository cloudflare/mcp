/**
 * Which API token permission groups a Cloudflare member role reaches, worked
 * out from the permission keys IAM seeds both with (`cloudflare/www/bach`,
 * `etc/seed/prod/roles`). `scripts/generate-member-permissions.ts` writes the
 * result to `src/auth/member-role-permissions.json`.
 *
 * Pure functions, so tests can run them on small fixtures.
 */
import { parse } from 'yaml'

/** A role as a seed file defines it. */
export interface RoleDefinition {
  readonly name: string
  /** Names the role had before a rename; `/memberships` may still report one. */
  readonly previousNames: readonly string[]
  /** Permission keys, such as `com.cloudflare.api.account.d1.read`. */
  readonly keys: readonly string[]
  /** The resource type the role applies to, such as `com.cloudflare.api.account`. */
  readonly scope?: string
}

interface SeedFile {
  seed?: Array<{
    type?: string
    data?: {
      name?: string
      attributes?: { applicable_scopes?: string }
      permissions?: Array<{ key?: string }>
    }
    previous?: Array<{ name?: string }>
  }>
}

/**
 * The roles in one seed file.
 *
 * @param text - The YAML of a file under `etc/seed/prod/roles`.
 * @returns Each `role` entry with a name.
 */
export function parseRoles(text: string): RoleDefinition[] {
  const file = (parse(text) ?? {}) as SeedFile
  return (file.seed ?? []).flatMap((entry) => {
    const name = entry.data?.name
    if (entry.type !== 'role' || !name) return []
    return [
      {
        name,
        previousNames: (entry.previous ?? []).flatMap((previous) =>
          previous.name && previous.name !== name ? [previous.name] : []
        ),
        keys: (entry.data?.permissions ?? []).flatMap((permission) =>
          permission.key ? [permission.key] : []
        ),
        ...(entry.data?.attributes?.applicable_scopes && {
          scope: entry.data.attributes.applicable_scopes
        })
      }
    ]
  })
}

/**
 * Whether `held` grants `key`. A held key ending in `.*` grants every key
 * below it, including narrower wildcards.
 */
export function holdsKey(held: readonly string[], key: string): boolean {
  return held.some((h) => h === key || (h.endsWith('.*') && key.startsWith(h.slice(0, -1))))
}

/**
 * Keys that only read: `read` and `list`, and the few verbs that inspect
 * without changing anything (peeking at a queue, evaluating a flag, verifying
 * or analyzing a certificate, pulling an image, reading history).
 */
const READ_KEY = /\.(read|list|list_self|peek|evaluate|verify|analyze|report|pull|[a-z]+-history)$/

/**
 * Whether a member role reaches an API token permission group.
 *
 * An endpoint checks one or two keys, but the spec only names the groups it
 * accepts, and groups bundle many keys. Requiring every key would hide tools
 * from narrow roles that can use them: Audit Logs Viewer can read audit logs,
 * which accept Account Settings Read, yet holds two of its keys. So the role
 * reaches the group when it holds one of the group's keys outside `baseline`
 * (the keys every member holds) and, if the group grants any write key, one of
 * those too. Read-only roles then never reach write groups.
 *
 * @param member - The member role's keys.
 * @param group - The permission group's keys.
 * @param baseline - Keys every member holds, such as `com.cloudflare.api.account.read`.
 */
export function reaches(
  member: readonly string[],
  group: readonly string[],
  baseline: readonly string[]
): boolean {
  if (group.length === 0) return false
  const distinctive = group.filter((key) => !holdsKey(baseline, key))
  if (distinctive.length === 0) return group.every((key) => holdsKey(member, key))
  if (!distinctive.some((key) => holdsKey(member, key))) return false
  const writes = distinctive.filter((key) => !READ_KEY.test(key))
  return writes.length === 0 || writes.some((key) => holdsKey(member, key))
}

/**
 * The permission groups each member role reaches.
 *
 * @param members - Member roles.
 * @param groups - API token permission groups.
 * @param baseline - Keys every member holds.
 * @returns Group names by member role name, without roles that reach none.
 */
export function memberRoleReach(
  members: readonly RoleDefinition[],
  groups: readonly RoleDefinition[],
  baseline: readonly string[]
): Map<string, string[]> {
  const reach = new Map<string, string[]>()
  for (const member of members) {
    const reached = groups
      .filter((group) => reaches(member.keys, group.keys, baseline))
      .map((group) => group.name)
    if (reached.length > 0) reach.set(member.name, [...new Set(reached)].sort())
  }
  return reach
}

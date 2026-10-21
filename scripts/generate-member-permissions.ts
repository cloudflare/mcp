/**
 * Regenerates `src/auth/member-role-permissions.json`: the API token
 * permissions each Cloudflare member role reaches, which `src/member-permissions.ts`
 * uses to hide direct tools a user's roles can't use.
 *
 *   npm run generate:member-permissions -- --roles path/to/bach/etc/seed/prod/roles [--spec openapi.forge.json]
 *
 * The roles come from IAM's seed files in the internal `cloudflare/www/bach`
 * repository, so this runs by hand, not in CI:
 *
 *   git clone --depth 1 --filter=blob:none --sparse --branch staging git@gitlab.cfdata.org:cloudflare/www/bach.git
 *   git -C bach sparse-checkout set etc/seed/prod/roles
 *
 * The file is public, so it holds no permission keys, names only the
 * permissions the public spec uses, and keys roles by a hash of their name:
 * the seed files include roles for products that haven't launched.
 * Without `--spec`, the latest `openapi.forge.json` Forge release is downloaded.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { canonicalPermission } from '../src/api-permissions'
import { memberRoleReach, parseRoles, type RoleDefinition } from './lib/member-role-coverage'

const SPEC_URL = 'https://github.com/cloudflare/forge/releases/latest/download/openapi.forge.json'
const OUT = 'src/auth/member-role-permissions.json'
/** The role every member holds at least; its keys are the baseline. */
const BASELINE_ROLE = 'Minimal Account Access'
/** Permissions a user holds as a user, whatever their account roles. */
const USER_SCOPE = 'com.cloudflare.api.user'
const METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options'])

const { values } = parseArgs({ options: { roles: { type: 'string' }, spec: { type: 'string' } } })
if (!values.roles) throw new Error('--roles <bach>/etc/seed/prod/roles is required')

function loadRoles(dir: string): RoleDefinition[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.yaml'))
    .flatMap((file) => parseRoles(readFileSync(join(dir, file), 'utf8')))
}

async function loadSpec(path: string | undefined): Promise<unknown> {
  if (path) return JSON.parse(readFileSync(path, 'utf8'))
  console.log(`Downloading ${SPEC_URL}`)
  const response = await fetch(SPEC_URL)
  if (!response.ok) throw new Error(`Failed to download the spec: HTTP ${response.status}`)
  return response.json()
}

/** Every permission an operation in the spec accepts, by its canonical name. */
function specPermissions(spec: unknown): Set<string> {
  const names = new Set<string>()
  const paths = (spec as { paths?: Record<string, Record<string, unknown>> }).paths ?? {}
  for (const item of Object.values(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.has(method)) continue
      const group = (operation as { 'x-api-token-group'?: unknown })?.['x-api-token-group']
      if (!Array.isArray(group)) continue
      for (const name of group) if (typeof name === 'string') names.add(canonicalPermission(name))
    }
  }
  return names
}

function roleKey(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 16)
}

function sourceRevision(dir: string): string {
  try {
    const commit = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8'
    }).trim()
    return `cloudflare/www/bach@${commit}`
  } catch {
    return 'cloudflare/www/bach'
  }
}

const members = loadRoles(join(values.roles, 'memberships'))
const groups = loadRoles(join(values.roles, 'api_tokens')).filter(
  (group) => group.scope !== USER_SCOPE
)
const baseline = members.find((member) => member.name === BASELINE_ROLE)?.keys
if (!baseline) throw new Error(`No "${BASELINE_ROLE}" member role in ${values.roles}`)

// The spec's name for each group it uses, which may be a name from before a rename.
const used = specPermissions(await loadSpec(values.spec))
const specNameOf = new Map<string, string>()
for (const group of groups) {
  const name = [group.name, ...group.previousNames].find((candidate) => used.has(candidate))
  if (name) specNameOf.set(group.name, name)
}
const permissions = [...new Set(specNameOf.values())].sort()
const index = new Map(permissions.map((name, i) => [name, i]))

const roles: Record<string, number[]> = {}
for (const [name, reached] of memberRoleReach(members, groups, baseline)) {
  const indices = reached.flatMap((group) => {
    const specName = specNameOf.get(group)
    return specName === undefined ? [] : [index.get(specName)!]
  })
  if (indices.length === 0) continue
  const member = members.find((role) => role.name === name)!
  for (const alias of [name, ...member.previousNames]) {
    const key = roleKey(alias)
    roles[key] = [...new Set([...(roles[key] ?? []), ...indices])].sort((a, b) => a - b)
  }
}

const sortedRoles = Object.fromEntries(Object.entries(roles).sort(([a], [b]) => a.localeCompare(b)))
writeFileSync(
  OUT,
  `${JSON.stringify({ source: sourceRevision(values.roles), permissions, roles: sortedRoles }, null, 2)}\n`
)
console.log(
  `Wrote ${OUT}: ${permissions.length} of ${used.size} spec permissions, ${Object.keys(sortedRoles).length} role names`
)

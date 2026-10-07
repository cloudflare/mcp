import scopeData from '../../src/auth/derived-oauth-scopes.json' with { type: 'json' }

/**
 * Which operations an OAuth connection can call.
 *
 * OAuth scopes share API token permission names, so an operation is reachable
 * when any permission in its `x-api-token-group` has an OAuth scope. Forge has
 * no OAuth marker of its own, and some of its permission labels are stale or
 * malformed, so this keeps an alias table; see the Forge inconsistencies log.
 */

/** Permission labels in Forge that name an OAuth scope under a different name. */
export const PERMISSION_ALIASES: Readonly<Record<string, string>> = {
  'Browser Rendering Read': 'Browser Run Read',
  'Browser Rendering Write': 'Browser Run Write',
  'Artifacts Edit': 'Artifacts Write',
  'Zone Zone Read': 'Zone Read',
  'Zone Zone Edit': 'Zone Write',
  'Zone DNS Edit': 'DNS Write',
  'Account Read': 'Account Settings Read',
  '#reports:read': 'Account Analytics Read'
}

const SCOPE_NAMES: ReadonlySet<string> = new Set(
  Object.values(scopeData as Record<string, { name: string }>).map(({ name }) => name)
)

/** The scope name a Forge permission label stands for. */
export function permissionName(label: string): string {
  return PERMISSION_ALIASES[label] ?? label
}

export type OAuthReach =
  | { reachable: true; permissions: 'scoped' | 'unknown' | 'public' }
  | { reachable: false; reason: string }

/**
 * Whether an OAuth connection can call an operation. Operations that list no
 * permissions stay reachable (`GET /accounts` lists none and every grant can
 * call it); only a special security scheme or a permission list with no OAuth
 * scope rules one out.
 */
export function oauthReach(
  document: Record<string, unknown>,
  operation: Record<string, unknown>
): OAuthReach {
  const requirements = (operation.security ?? document.security ?? []) as Array<
    Record<string, unknown>
  >
  const schemes = requirements.flatMap((requirement) => Object.keys(requirement))
  if (schemes.length && !schemes.includes('api_token')) {
    return { reachable: false, reason: `needs ${schemes.join(' or ')}` }
  }
  const labels = Array.isArray(operation['x-api-token-group'])
    ? (operation['x-api-token-group'] as unknown[]).filter(
        (label): label is string => typeof label === 'string'
      )
    : []
  if (!labels.length) return { reachable: true, permissions: schemes.length ? 'unknown' : 'public' }
  if (labels.some((label) => SCOPE_NAMES.has(permissionName(label)))) {
    return { reachable: true, permissions: 'scoped' }
  }
  return { reachable: false, reason: `no OAuth scope for ${labels.join(', ')}` }
}

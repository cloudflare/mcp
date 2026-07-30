import { DERIVED_OAUTH_SCOPES, type ScopeDefinition } from './derived-oauth-scopes'

const CORE_SCOPE_DEFINITIONS = {
  offline_access: {
    description: 'Grants refresh tokens for long-lived access',
    category: 'Core'
  },
  'user:read': {
    description: 'See your user info such as name, email address, and account memberships',
    category: 'Core'
  },
  'account:read': {
    description: 'See your account info such as account details, analytics, and memberships',
    category: 'Core'
  }
} as const satisfies Record<string, ScopeDefinition>

const FULL_ACCESS_EXCLUSIONS = new Set<string>([
  // Sensitive PII scopes are opt-in only.
  'fraud-detection-pii.read',
  'teams-pii.read',
  // High-volume write access is opt-in only.
  'logs.write',
  // Redundant when the write scope is selected.
  'ssl-and-certificates.read'
])

export type ScopeName = keyof typeof CORE_SCOPE_DEFINITIONS | keyof typeof DERIVED_OAUTH_SCOPES

export interface ScopeTemplate {
  name: string
  description: string
  scopes: readonly ScopeName[]
}

/** Maximum scopes requested in one authorization. Undefined means no app-side cap. */
export const MAX_SCOPES: number | undefined = undefined

/** Scopes required for identity, account discovery, and refresh tokens. */
export const REQUIRED_SCOPES = [
  'user:read',
  'offline_access',
  'account:read'
] as const satisfies readonly ScopeName[]

/** Scope templates for quick selection. `custom` is surfaced client-side only. */
export type TemplateName = 'read-only' | 'yolo'

/** Default template; read-only is safest. */
export const DEFAULT_TEMPLATE: TemplateName = 'read-only'

function isReadOnlyScope(scope: string): boolean {
  if (scope.includes('pii')) return false
  const action = scope.split(/[:.]/).at(-1)
  return (
    action === 'read' ||
    action === 'metadata_read' ||
    action === 'monitoring' ||
    action === 'report'
  )
}

const definitions: Record<string, ScopeDefinition> = {
  ...CORE_SCOPE_DEFINITIONS,
  ...DERIVED_OAUTH_SCOPES
}

/** Canonical production OAuth scopes available in every deployment's picker. */
export const ALL_SCOPES = Object.fromEntries(
  Object.entries(definitions).map(([scope, definition]) => [scope, definition.description])
)

/** Public API categories used to group scopes in the picker. */
export const SCOPE_CATEGORIES = Object.fromEntries(
  Object.entries(definitions).map(([scope, definition]) => [scope, definition.category])
)

const scopeNames = Object.keys(definitions) as ScopeName[]
const readOnlyScopes = Array.from(
  new Set<ScopeName>([...REQUIRED_SCOPES, ...scopeNames.filter(isReadOnlyScope)])
)
const fullAccessScopes = scopeNames.filter((scope) => !FULL_ACCESS_EXCLUSIONS.has(scope))

export const SCOPE_TEMPLATES: Record<TemplateName, ScopeTemplate> = {
  'read-only': {
    name: 'Read only',
    description:
      'View resources without making changes. Safest for exploration and read workflows.',
    scopes: readOnlyScopes
  },
  yolo: {
    name: 'Full access',
    description:
      'Everything the MCP server can do. Skips sensitive PII, high-volume, and redundant scopes. Use with trusted clients only.',
    scopes: fullAccessScopes
  }
}

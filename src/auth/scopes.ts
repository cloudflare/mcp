import { DERIVED_OAUTH_SCOPES, type ScopeDefinition } from './derived-oauth-scopes'

const CORE_SCOPE_DEFINITIONS = {
  offline_access: {
    name: 'Offline access',
    category: 'Core'
  },
  'user:read': {
    name: 'User Read',
    category: 'Core'
  },
  'account:read': {
    name: 'Account Read',
    category: 'Core'
  }
} as const satisfies Record<string, ScopeDefinition>

export type ScopeName = keyof typeof CORE_SCOPE_DEFINITIONS | keyof typeof DERIVED_OAUTH_SCOPES

/** A preset set of scopes offered on the consent page. */
export interface ScopeTemplate {
  name: string
  scopes: readonly ScopeName[]
}

/** Scopes required for identity, account discovery, and refresh tokens. */
export const REQUIRED_SCOPES = [
  'user:read',
  'offline_access',
  'account:read'
] as const satisfies readonly ScopeName[]

/** The two built-in permission presets. */
export type TemplateName = 'read-only' | 'full-access'

/** Default template; read-only is safest. */
export const DEFAULT_TEMPLATE: TemplateName = 'read-only'

function isReadOnlyScope(scope: string): boolean {
  const action = scope.split(/[:.]/).at(-1)
  return (
    action === 'read' ||
    action === 'metadata_read' ||
    action === 'monitoring' ||
    action === 'report'
  )
}

/** Canonical production catalog plus required OAuth bootstrap scopes. */
export const SCOPE_DEFINITIONS: Record<string, ScopeDefinition> = {
  ...CORE_SCOPE_DEFINITIONS,
  ...DERIVED_OAUTH_SCOPES
}

const scopeNames = Object.keys(SCOPE_DEFINITIONS) as ScopeName[]
const readOnlyScopes = Array.from(
  new Set<ScopeName>([...REQUIRED_SCOPES, ...scopeNames.filter(isReadOnlyScope)])
)
export const SCOPE_TEMPLATES: Record<TemplateName, ScopeTemplate> = {
  'read-only': {
    name: 'Read only',
    scopes: readOnlyScopes
  },
  'full-access': {
    name: 'Full access',
    scopes: scopeNames
  }
}

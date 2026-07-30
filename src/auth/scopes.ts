import {
  PRODUCTION_DERIVED_SCOPES,
  STAGING_DERIVED_SCOPES,
  type ScopeDefinition
} from './derived-oauth-scopes'

/** OAuth environment whose API-token-derived scopes are registered for this deployment. */
export type ScopeEnvironment = 'production' | 'staging'

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

/**
 * Legacy internal scopes whose permissions are not fully available through API-token-derived scopes.
 * Keep these in the picker until an API-token role exposes all of their remaining permissions.
 */
const SPECIAL_LEGACY_SCOPES = {
  'access:read': {
    description: 'See Cloudflare Access data not yet covered by derived scopes',
    category: 'Cloudflare One / Zero Trust'
  },
  'access:write': {
    description: 'Manage Cloudflare Access data not yet covered by derived scopes',
    category: 'Cloudflare One / Zero Trust'
  },
  'workers:write': {
    description: 'Manage legacy Workers resources not yet covered by derived scopes',
    category: 'Developer Platform'
  },
  'workers_scripts:write': {
    description: 'Manage privileged Worker script settings not yet covered by derived scopes',
    category: 'Developer Platform'
  },
  'd1:write': {
    description: 'Manage legacy D1 resources not yet covered by derived scopes',
    category: 'Developer Platform'
  },
  'pipelines:setup': {
    description: 'Generate R2 tokens for Workers Pipelines',
    category: 'Developer Platform'
  },
  'query_cache:write': {
    description: 'Manage legacy Hyperdrive resources not yet covered by derived scopes',
    category: 'Developer Platform'
  },
  'containers:write': {
    description: 'Manage legacy Workers Containers resources not yet covered by derived scopes',
    category: 'Developer Platform'
  },
  'teams:read': {
    description: 'View Zero Trust data not yet covered by derived scopes',
    category: 'Cloudflare One / Zero Trust'
  },
  'teams:write': {
    description: 'Manage Zero Trust data not yet covered by derived scopes',
    category: 'Cloudflare One / Zero Trust'
  },
  'sso-connector:read': {
    description: 'View SSO connectors',
    category: 'Cloudflare One / Zero Trust'
  },
  'sso-connector:write': {
    description: 'Manage SSO connectors',
    category: 'Cloudflare One / Zero Trust'
  },
  'cfone:write': {
    description: 'Manage Cloudforce One data not yet covered by derived scopes',
    category: 'App Security'
  }
} as const satisfies Record<string, ScopeDefinition>

/** Staging's derived Cloudforce One scope does not yet cover detection-rule reads. */
const STAGING_ONLY_SPECIAL_LEGACY_SCOPES = {
  'cfone:read': {
    description: 'View Cloudforce One data not yet covered by staging derived scopes',
    category: 'App Security'
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

export type ScopeName =
  | keyof typeof CORE_SCOPE_DEFINITIONS
  | keyof typeof SPECIAL_LEGACY_SCOPES
  | keyof typeof STAGING_ONLY_SPECIAL_LEGACY_SCOPES
  | keyof typeof PRODUCTION_DERIVED_SCOPES
  | keyof typeof STAGING_DERIVED_SCOPES

export interface ScopeTemplate {
  name: string
  description: string
  scopes: readonly ScopeName[]
}

export interface ScopeConfiguration {
  allScopes: Record<string, string>
  scopeCategories: Record<string, string>
  scopeTemplates: Record<TemplateName, ScopeTemplate>
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

function createScopeConfiguration(environment: ScopeEnvironment): ScopeConfiguration {
  const derivedScopes =
    environment === 'staging' ? STAGING_DERIVED_SCOPES : PRODUCTION_DERIVED_SCOPES
  const definitions: Record<string, ScopeDefinition> = {
    ...CORE_SCOPE_DEFINITIONS,
    ...SPECIAL_LEGACY_SCOPES,
    ...(environment === 'staging' ? STAGING_ONLY_SPECIAL_LEGACY_SCOPES : {}),
    ...derivedScopes
  }

  const allScopes = Object.fromEntries(
    Object.entries(definitions).map(([scope, definition]) => [scope, definition.description])
  )
  const scopeCategories = Object.fromEntries(
    Object.entries(definitions).map(([scope, definition]) => [scope, definition.category])
  )
  const scopeNames = Object.keys(definitions) as ScopeName[]
  const readOnlyScopes = Array.from(
    new Set<ScopeName>([...REQUIRED_SCOPES, ...scopeNames.filter(isReadOnlyScope)])
  )
  const fullAccessScopes = scopeNames.filter((scope) => !FULL_ACCESS_EXCLUSIONS.has(scope))

  return {
    allScopes,
    scopeCategories,
    scopeTemplates: {
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
  }
}

const CONFIGURATIONS: Record<ScopeEnvironment, ScopeConfiguration> = {
  production: createScopeConfiguration('production'),
  staging: createScopeConfiguration('staging')
}

export function getScopeEnvironment(apiBase: string): ScopeEnvironment {
  return new URL(apiBase).hostname === 'api.staging.cloudflare.com' ? 'staging' : 'production'
}

export function getScopeConfiguration(environment: ScopeEnvironment): ScopeConfiguration {
  return CONFIGURATIONS[environment]
}

/** Production defaults retained for callers and tests that do not select an environment. */
export const {
  allScopes: ALL_SCOPES,
  scopeCategories: SCOPE_CATEGORIES,
  scopeTemplates: SCOPE_TEMPLATES
} = CONFIGURATIONS.production

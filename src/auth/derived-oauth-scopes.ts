import scopeData from './derived-oauth-scopes.json'

/** Metadata for an API-token-derived OAuth scope. */
export interface ScopeDefinition {
  description: string
  category: string
}

type ScopeDefinitions = Record<string, ScopeDefinition>

const COMMON_DERIVED_SCOPES = scopeData.common satisfies ScopeDefinitions
const PRODUCTION_ONLY_DERIVED_SCOPES = scopeData.productionOnly satisfies ScopeDefinitions
const STAGING_DERIVED_SCOPE_OVERRIDES = scopeData.stagingOverrides satisfies ScopeDefinitions
const STAGING_ONLY_DERIVED_SCOPES = scopeData.stagingOnly satisfies ScopeDefinitions

export const PRODUCTION_DERIVED_SCOPES = {
  ...COMMON_DERIVED_SCOPES,
  ...PRODUCTION_ONLY_DERIVED_SCOPES
} as const satisfies ScopeDefinitions

export const STAGING_DERIVED_SCOPES = {
  ...COMMON_DERIVED_SCOPES,
  ...STAGING_DERIVED_SCOPE_OVERRIDES,
  ...STAGING_ONLY_DERIVED_SCOPES
} as const satisfies ScopeDefinitions

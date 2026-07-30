import scopeData from './derived-oauth-scopes.json'

/** Metadata returned by the public OAuth scope catalog. */
export interface ScopeDefinition {
  name: string
  category: string
}

type ScopeDefinitions = Record<string, ScopeDefinition>

/** Canonical production OAuth scope catalog used by every MCP deployment. */
export const DERIVED_OAUTH_SCOPES = scopeData satisfies ScopeDefinitions

import scopeData from './derived-oauth-scopes.json'

/** Metadata returned by the public OAuth scope catalog. */
export interface ScopeDefinition {
  name: string
  category: string
}

type ScopeDefinitions = Record<string, ScopeDefinition>

/** Canonical production OAuth scope catalog used by every MCP deployment. */
export const DERIVED_OAUTH_SCOPES = scopeData satisfies ScopeDefinitions

/**
 * Scopes outside Cloudflare's public catalog that Cloudflare still grants this
 * server's OAuth client, which is on its internal allowlist. They are kept out
 * of `derived-oauth-scopes.json`, which mirrors the catalog.
 */
export const INTERNAL_OAUTH_SCOPES = {
  'billing:read': { name: 'Billing Read', category: 'Account & Billing' },
  'billing:write': { name: 'Billing Write', category: 'Account & Billing' }
} as const satisfies ScopeDefinitions

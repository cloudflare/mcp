import { describe, expect, it } from 'vitest'

import {
  PRODUCTION_DERIVED_SCOPES,
  STAGING_DERIVED_SCOPES
} from '../../src/auth/derived-oauth-scopes'
import {
  ALL_SCOPES,
  DEFAULT_TEMPLATE,
  MAX_SCOPES,
  REQUIRED_SCOPES,
  SCOPE_CATEGORIES,
  SCOPE_TEMPLATES,
  getScopeConfiguration,
  getScopeEnvironment,
  type ScopeEnvironment
} from '../../src/auth/scopes'

const ENVIRONMENTS = ['production', 'staging'] as const satisfies readonly ScopeEnvironment[]

const PRODUCTION_ONLY_SCOPES = [
  'field-extractor.read',
  'field-extractor.write',
  'messaging.edit',
  'messaging.metadata_read',
  'messaging.read',
  'payments-gateway.read',
  'payments-gateway.write',
  'websearch.metadata_read',
  'websearch.read',
  'websearch.write'
] as const

const STAGING_ONLY_SCOPES = [
  'teams-gateway.read',
  'teams-gateway.write',
  'workers-scripts.edit',
  'workers-scripts.metadata_read',
  'workers-vpc.admin',
  'workers-vpc.bind',
  'workers-vpc.read',
  'workflows.metadata_read',
  'workflows.read',
  'workflows.write'
] as const

const PRODUCTION_SPECIAL_LEGACY_SCOPES = [
  'access:read',
  'access:write',
  'workers:write',
  'workers_scripts:write',
  'd1:write',
  'pipelines:setup',
  'query_cache:write',
  'containers:write',
  'teams:read',
  'teams:write',
  'sso-connector:read',
  'sso-connector:write',
  'cfone:write'
] as const

const REPLACED_LEGACY_SCOPES = [
  'workers:read',
  'workers_kv:write',
  'workers_routes:write',
  'workers_tail:read',
  'workers_deployments:read',
  'workers_builds:read',
  'workers_builds:write',
  'workers_observability:read',
  'workers_observability:write',
  'workers_observability_telemetry:write',
  'pages:read',
  'pages:write',
  'ai:read',
  'ai:write',
  'aig:read',
  'aig:write',
  'aiaudit:read',
  'aiaudit:write',
  'ai-search:read',
  'ai-search:write',
  'ai-search:run',
  'dns_records:read',
  'dns_records:edit',
  'dns_settings:read',
  'dns_analytics:read',
  'zone:read',
  'logpush:read',
  'logpush:write',
  'auditlogs:read',
  'lb:read',
  'lb:edit',
  'notification:read',
  'notification:write',
  'queues:write',
  'pipelines:read',
  'pipelines:write',
  'r2_catalog:write',
  'vectorize:write',
  'secrets_store:read',
  'secrets_store:write',
  'browser:read',
  'browser:write',
  'connectivity:admin',
  'connectivity:bind',
  'connectivity:read',
  'dex:read',
  'dex:write',
  'url_scanner:read',
  'url_scanner:write',
  'radar:read',
  'mcp_portals:read',
  'mcp_portals:write',
  'email_routing:write',
  'email_sending:write'
] as const

function sorted(values: Iterable<string>): string[] {
  return [...values].sort()
}

function difference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value))
}

describe('API-token-derived scopes', () => {
  it('contains the complete 380-scope set for each environment', () => {
    expect(Object.keys(PRODUCTION_DERIVED_SCOPES)).toHaveLength(380)
    expect(Object.keys(STAGING_DERIVED_SCOPES)).toHaveLength(380)
  })

  it('uses dot notation and complete picker metadata', () => {
    for (const scopes of [PRODUCTION_DERIVED_SCOPES, STAGING_DERIVED_SCOPES]) {
      for (const [scope, definition] of Object.entries(scopes)) {
        expect(scope).toMatch(/^[a-z0-9_-]+\.[a-z0-9_-]+$/)
        expect(definition.description.length).toBeGreaterThan(0)
        expect(definition.category.length).toBeGreaterThan(0)
      }
    }
  })

  it('tracks the intentional environment differences', () => {
    const production = new Set(Object.keys(PRODUCTION_DERIVED_SCOPES))
    const staging = new Set(Object.keys(STAGING_DERIVED_SCOPES))

    expect(sorted(difference(production, staging))).toEqual(sorted(PRODUCTION_ONLY_SCOPES))
    expect(sorted(difference(staging, production))).toEqual(sorted(STAGING_ONLY_SCOPES))
  })
})

describe('scope configurations', () => {
  it.each(ENVIRONMENTS)('%s includes every derived scope and complete metadata', (environment) => {
    const configuration = getScopeConfiguration(environment)
    const derived =
      environment === 'production' ? PRODUCTION_DERIVED_SCOPES : STAGING_DERIVED_SCOPES

    for (const scope of Object.keys(derived)) {
      expect(configuration.allScopes).toHaveProperty(scope)
      expect(configuration.scopeCategories).toHaveProperty(scope)
    }
    expect(sorted(Object.keys(configuration.allScopes))).toEqual(
      sorted(Object.keys(configuration.scopeCategories))
    )
  })

  it('retains OAuth bootstrap and special production legacy scopes only', () => {
    const productionScopes = new Set(Object.keys(getScopeConfiguration('production').allScopes))
    const expectedColonScopes = new Set([
      'user:read',
      'account:read',
      ...PRODUCTION_SPECIAL_LEGACY_SCOPES
    ])

    expect(new Set([...productionScopes].filter((scope) => scope.includes(':')))).toEqual(
      expectedColonScopes
    )
    expect(productionScopes).toContain('offline_access')
    expect(productionScopes).toHaveLength(396)
  })

  it('retains the additional special Cloudforce One read scope in staging only', () => {
    const productionScopes = new Set(Object.keys(getScopeConfiguration('production').allScopes))
    const stagingScopes = new Set(Object.keys(getScopeConfiguration('staging').allScopes))

    expect(productionScopes).not.toContain('cfone:read')
    expect(stagingScopes).toContain('cfone:read')
    expect(stagingScopes).toHaveLength(397)
  })

  it.each(REPLACED_LEGACY_SCOPES)('removes replaceable legacy scope %s', (scope) => {
    expect(getScopeConfiguration('production').allScopes).not.toHaveProperty(scope)
    expect(getScopeConfiguration('staging').allScopes).not.toHaveProperty(scope)
  })

  it('uses production as the exported default', () => {
    const production = getScopeConfiguration('production')

    expect(ALL_SCOPES).toBe(production.allScopes)
    expect(SCOPE_CATEGORIES).toBe(production.scopeCategories)
    expect(SCOPE_TEMPLATES).toBe(production.scopeTemplates)
  })

  it('selects scope environment from the Cloudflare API base', () => {
    expect(getScopeEnvironment('https://api.staging.cloudflare.com/client/v4')).toBe('staging')
    expect(getScopeEnvironment('https://api.cloudflare.com/client/v4')).toBe('production')
  })
})

describe('scope templates', () => {
  it('has a valid default template in every environment', () => {
    for (const environment of ENVIRONMENTS) {
      expect(getScopeConfiguration(environment).scopeTemplates[DEFAULT_TEMPLATE]).toBeDefined()
    }
  })

  it.each(ENVIRONMENTS)('%s templates contain only registered scopes', (environment) => {
    const { allScopes, scopeTemplates } = getScopeConfiguration(environment)
    const registeredScopes = new Set(Object.keys(allScopes))

    for (const template of Object.values(scopeTemplates)) {
      for (const scope of template.scopes) expect(registeredScopes).toContain(scope)
    }
  })

  it.each(ENVIRONMENTS)('%s templates include all required scopes', (environment) => {
    const { scopeTemplates } = getScopeConfiguration(environment)

    for (const template of Object.values(scopeTemplates)) {
      for (const scope of REQUIRED_SCOPES) expect(template.scopes).toContain(scope)
    }
  })

  it.each(ENVIRONMENTS)('%s read-only template excludes writes and PII', (environment) => {
    const readOnly = getScopeConfiguration(environment).scopeTemplates['read-only'].scopes

    expect(
      readOnly.some((scope) => /[.:](write|edit|admin|bind|setup|run|index)$/.test(scope))
    ).toBe(false)
    expect(readOnly.some((scope) => scope.includes('pii'))).toBe(false)
    expect(readOnly).toContain('aig.metadata_read')
  })

  it.each(ENVIRONMENTS)(
    '%s full-access template skips sensitive and redundant scopes',
    (environment) => {
      const fullAccess = getScopeConfiguration(environment).scopeTemplates.yolo.scopes

      expect(fullAccess).not.toContain('fraud-detection-pii.read')
      expect(fullAccess).not.toContain('teams-pii.read')
      expect(fullAccess).not.toContain('logs.write')
      expect(fullAccess).not.toContain('ssl-and-certificates.read')
      expect(fullAccess).toContain('ssl-and-certificates.write')
    }
  )
})

describe('MAX_SCOPES', () => {
  it('does not impose an app-side scope cap', () => {
    expect(MAX_SCOPES).toBeUndefined()
  })
})

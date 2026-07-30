import { describe, expect, it } from 'vitest'

import { DERIVED_OAUTH_SCOPES } from '../../src/auth/derived-oauth-scopes'
import {
  ALL_SCOPES,
  DEFAULT_TEMPLATE,
  MAX_SCOPES,
  REQUIRED_SCOPES,
  SCOPE_CATEGORIES,
  SCOPE_TEMPLATES
} from '../../src/auth/scopes'

const REPLACED_LEGACY_SCOPES = [
  'access:read',
  'access:write',
  'workers:read',
  'workers:write',
  'workers_scripts:write',
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
  'd1:write',
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
  'pipelines:setup',
  'pipelines:write',
  'r2_catalog:write',
  'vectorize:write',
  'query_cache:write',
  'secrets_store:read',
  'secrets_store:write',
  'browser:read',
  'browser:write',
  'containers:write',
  'teams:read',
  'teams:write',
  'teams:pii',
  'teams:secure_location',
  'sso-connector:read',
  'sso-connector:write',
  'connectivity:admin',
  'connectivity:bind',
  'connectivity:read',
  'cfone:read',
  'cfone:write',
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

describe('canonical OAuth scope catalog', () => {
  it('contains the 380 production scopes returned by the public API', () => {
    expect(Object.keys(DERIVED_OAUTH_SCOPES)).toHaveLength(380)
  })

  it('uses dot notation and complete picker metadata', () => {
    for (const [scope, definition] of Object.entries(DERIVED_OAUTH_SCOPES)) {
      expect(scope).toMatch(/^[a-z0-9_-]+\.[a-z0-9_-]+$/)
      expect(definition.description.length).toBeGreaterThan(0)
      expect(definition.category.length).toBeGreaterThan(0)
    }
  })

  it('uses only the production Realtime labels', () => {
    expect(DERIVED_OAUTH_SCOPES).toHaveProperty('realtime.admin')
    expect(DERIVED_OAUTH_SCOPES).toHaveProperty('realtime.write')
    expect(DERIVED_OAUTH_SCOPES).not.toHaveProperty('realtime.read')
    expect(DERIVED_OAUTH_SCOPES).not.toHaveProperty('realtime.realtime')
  })

  it.each([
    'agent-memory.read',
    'audit-logs.read',
    'custom-ns.write',
    'teams-gateway.read',
    'workers-vpc.read',
    'workflows.read'
  ])('does not expose staging-only scope %s', (scope) => {
    expect(DERIVED_OAUTH_SCOPES).not.toHaveProperty(scope)
  })
})

describe('scope configuration', () => {
  it('includes every canonical scope and category', () => {
    for (const scope of Object.keys(DERIVED_OAUTH_SCOPES)) {
      expect(ALL_SCOPES).toHaveProperty(scope)
      expect(SCOPE_CATEGORIES).toHaveProperty(scope)
    }
    expect(Object.keys(ALL_SCOPES).sort()).toEqual(Object.keys(SCOPE_CATEGORIES).sort())
  })

  it('retains only OAuth bootstrap scopes outside the canonical catalog', () => {
    const scopes = new Set(Object.keys(ALL_SCOPES))

    expect(new Set([...scopes].filter((scope) => scope.includes(':')))).toEqual(
      new Set(['user:read', 'account:read'])
    )
    expect(scopes).toContain('offline_access')
    expect(scopes).toHaveLength(383)
  })

  it.each(REPLACED_LEGACY_SCOPES)('removes legacy scope %s', (scope) => {
    expect(ALL_SCOPES).not.toHaveProperty(scope)
  })
})

describe('scope templates', () => {
  it('has a valid default template', () => {
    expect(SCOPE_TEMPLATES[DEFAULT_TEMPLATE]).toBeDefined()
  })

  it('contains only registered scopes', () => {
    const registeredScopes = new Set(Object.keys(ALL_SCOPES))

    for (const template of Object.values(SCOPE_TEMPLATES)) {
      for (const scope of template.scopes) expect(registeredScopes).toContain(scope)
    }
  })

  it('includes all required scopes', () => {
    for (const template of Object.values(SCOPE_TEMPLATES)) {
      for (const scope of REQUIRED_SCOPES) expect(template.scopes).toContain(scope)
    }
  })

  it('keeps writes and PII out of the read-only template', () => {
    const readOnly = SCOPE_TEMPLATES['read-only'].scopes

    expect(
      readOnly.some((scope) => /[.:](write|edit|admin|bind|setup|run|index)$/.test(scope))
    ).toBe(false)
    expect(readOnly.some((scope) => scope.includes('pii'))).toBe(false)
    expect(readOnly).toContain('aig.metadata_read')
  })

  it('keeps sensitive, high-volume, and redundant scopes out of full access', () => {
    const fullAccess = SCOPE_TEMPLATES.yolo.scopes

    expect(fullAccess).not.toContain('fraud-detection-pii.read')
    expect(fullAccess).not.toContain('teams-pii.read')
    expect(fullAccess).not.toContain('logs.write')
    expect(fullAccess).not.toContain('ssl-and-certificates.read')
    expect(fullAccess).toContain('ssl-and-certificates.write')
  })
})

describe('MAX_SCOPES', () => {
  it('does not impose an app-side scope cap', () => {
    expect(MAX_SCOPES).toBeUndefined()
  })
})

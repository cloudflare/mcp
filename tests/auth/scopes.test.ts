import { describe, it, expect } from 'vitest'
import {
  ALL_SCOPES,
  SCOPE_TEMPLATES,
  REQUIRED_SCOPES,
  DEFAULT_TEMPLATE,
  MAX_SCOPES
} from '../../src/auth/scopes'

/**
 * Scopes registered for the OAuth client.
 * If you need to add a new scope, first register it with the OAuth provider, then add it here and to ALL_SCOPES.
 */
const REGISTERED_SCOPES = [
  'offline_access',
  'user:read',
  'account:read',
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
  'account-analytics.read',
  'logs.read',
  'logs.write',
  'account-ssl-and-certificates.write',
  'ssl-and-certificates.read',
  'ssl-and-certificates.write',
  'lb:read',
  'lb:edit',
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
  'email_sending:write',
  'registrar-domains.read',
  'registrar-domains.admin',
  'snippets.read',
  'snippets.write',
  'notification:read',
  'notification:write'
] as const

describe('scopes', () => {
  describe('ALL_SCOPES validation', () => {
    it('should only contain scopes that are registered', () => {
      const allScopeKeys = Object.keys(ALL_SCOPES)
      const registeredSet = new Set<string>(REGISTERED_SCOPES)

      const unregisteredScopes = allScopeKeys.filter((scope) => !registeredSet.has(scope))

      expect(unregisteredScopes).toEqual([])
    })

    it('should contain all registered scopes', () => {
      const allScopeKeys = new Set(Object.keys(ALL_SCOPES))

      const missingScopes = REGISTERED_SCOPES.filter((scope) => !allScopeKeys.has(scope))

      expect(missingScopes).toEqual([])
    })
  })

  describe('SCOPE_TEMPLATES', () => {
    it('should have a default template', () => {
      expect(SCOPE_TEMPLATES[DEFAULT_TEMPLATE]).toBeDefined()
    })

    it('all template scopes should be valid (in ALL_SCOPES)', () => {
      const allScopeKeys = new Set(Object.keys(ALL_SCOPES))

      for (const [templateName, template] of Object.entries(SCOPE_TEMPLATES)) {
        for (const scope of template.scopes) {
          expect(
            allScopeKeys.has(scope),
            `Template "${templateName}" contains invalid scope "${scope}"`
          ).toBe(true)
        }
      }
    })

    it('all template scopes should be registered', () => {
      const registeredSet = new Set(REGISTERED_SCOPES)

      for (const [templateName, template] of Object.entries(SCOPE_TEMPLATES)) {
        for (const scope of template.scopes) {
          expect(
            registeredSet.has(scope),
            `Template "${templateName}" contains unregistered scope "${scope}"`
          ).toBe(true)
        }
      }
    })

    it('read-only template should not contain write scopes', () => {
      const readOnlyTemplate = SCOPE_TEMPLATES['read-only']
      const writeScopes = readOnlyTemplate.scopes.filter(
        (scope) =>
          scope.endsWith(':write') ||
          scope.endsWith(':edit') ||
          scope.endsWith(':admin') ||
          scope.endsWith(':pii') ||
          scope.endsWith('.write') ||
          scope.endsWith('.admin')
      )

      expect(writeScopes).toEqual([])
    })

    it('read-only template should include dot-notation read scopes', () => {
      expect(SCOPE_TEMPLATES['read-only'].scopes).toContain('registrar-domains.read')
      expect(SCOPE_TEMPLATES['read-only'].scopes).toContain('logs.read')
      expect(SCOPE_TEMPLATES['read-only'].scopes).toContain('ssl-and-certificates.read')
      expect(SCOPE_TEMPLATES['read-only'].scopes).toContain('account-analytics.read')
    })

    it('full-access template should include account analytics access', () => {
      expect(SCOPE_TEMPLATES.yolo.scopes).toContain('account-analytics.read')
    })

    it('full-access template should include derived SSL certificate access', () => {
      expect(SCOPE_TEMPLATES.yolo.scopes).toContain('account-ssl-and-certificates.write')
      expect(SCOPE_TEMPLATES.yolo.scopes).toContain('ssl-and-certificates.write')
    })

    it('full-access template should preserve existing logs access', () => {
      expect(SCOPE_TEMPLATES.yolo.scopes).toContain('logs.read')
    })

    it('full-access template should skip sensitive, high-volume, or redundant scopes', () => {
      expect(SCOPE_TEMPLATES.yolo.scopes).not.toContain('teams:pii')
      expect(SCOPE_TEMPLATES.yolo.scopes).not.toContain('logs.write')
      expect(SCOPE_TEMPLATES.yolo.scopes).not.toContain('ssl-and-certificates.read')
    })
  })

  describe('REQUIRED_SCOPES', () => {
    it('should all be registered', () => {
      const registeredSet = new Set(REGISTERED_SCOPES)

      for (const scope of REQUIRED_SCOPES) {
        expect(registeredSet.has(scope), `Required scope "${scope}" is not registered`).toBe(true)
      }
    })

    it('should include user:read for user identification', () => {
      expect(REQUIRED_SCOPES).toContain('user:read')
    })

    it('should include offline_access for refresh tokens', () => {
      expect(REQUIRED_SCOPES).toContain('offline_access')
    })
  })

  describe('MAX_SCOPES', () => {
    it('should not impose an app-side scope cap', () => {
      expect(MAX_SCOPES).toBeUndefined()
    })

    it('all templates should be within the max scope limit when one is configured', () => {
      if (MAX_SCOPES === undefined) return

      for (const [templateName, template] of Object.entries(SCOPE_TEMPLATES)) {
        expect(
          template.scopes.length,
          `Template "${templateName}" has ${template.scopes.length} scopes, exceeding MAX_SCOPES (${MAX_SCOPES})`
        ).toBeLessThanOrEqual(MAX_SCOPES)
      }
    })
  })
})

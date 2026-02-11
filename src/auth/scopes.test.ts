import { describe, it, expect } from 'vitest'
import { ALL_SCOPES, SCOPE_TEMPLATES, REQUIRED_SCOPES, DEFAULT_TEMPLATE } from './scopes'

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
  'agw:read',
  'agw:run',
  'agw:write',
  'aiaudit:read',
  'aiaudit:write',
  'ai-search:read',
  'ai-search:write',
  'ai-search:run',
  'rag:read',
  'rag:write',
  'dns_records:read',
  'dns_records:edit',
  'dns_settings:read',
  'dns_analytics:read',
  'zone:read',
  'logpush:read',
  'logpush:write',
  'auditlogs:read',
  'ssl_certs:write',
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
  'constellation:write',
  'cloudchamber:write',
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
  'billing:read',
  'billing:write',
  'notebook-examples:read',
  'notebook-managed:read',
  'firstpartytags:write'
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
          scope.endsWith(':pii')
      )

      expect(writeScopes).toEqual([])
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
})

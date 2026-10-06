import { describe, expect, it } from 'vitest'
import { deriveOperationPolicies, deployedOperationPolicies, evaluateOperationScopes, matchOperationPolicy, PolicyArtifact, RESOLVER_VERSION } from '../src/auth/operation-scopes'
import { processSpec } from '../src/spec-processor'
import { verifiedScopeContext, ScopeController } from '../src/auth/scope-context'
import { grantedScopes } from '../src/auth/oauth-handler'

const paths = {
  '/accounts/{account_id}/workers/scripts/{script_name}': { put: { operationId: 'worker-upload', 'x-api-token-group': ['Workers Scripts Write'] } },
  '/zones/{zone_id}/dns_records': { post: { 'x-api-token-group': ['DNS Write'] } },
  '/accounts/{account_id}/workers/workers': { get: { 'x-api-token-group': ['Workers Tail Read', 'Workers Scripts Write', 'Workers Scripts Read'] } }
}
const policies = deriveOperationPolicies(paths)
function reviewed(index = 0) { return { ...policies[index], state: 'reviewed' as const, review: { source: 'test OAuth contract', version: 'test-v1' } } }
const auth = { token: 'not-forwarded', audience: 'https://mcp.cloudflare.com/mcp', userId: 'user', clientId: 'client', scope: ['user:read', 'account:read'] }

describe('operation scope candidates', () => {
  it('preserves validated permission labels and operation identifiers', () => {
    expect(processSpec({ paths }).paths).toMatchObject(paths)
    expect(processSpec({ paths: { '/test': { get: { 'x-api-token-group': [12] } } } }).paths['/test'].get).not.toHaveProperty('x-api-token-group', [12])
    expect(policies.find((policy) => policy.path.includes('dns_records'))?.alternatives).toEqual([{ label: 'DNS Write', scopes: ['dns.write'], unresolved: false }])
    expect(policies.every((policy) => policy.state === 'candidate')).toBe(true)
  })
  it('resolves all ambiguous account/zone labels by leading root context as candidates', () => {
    const labels = ['Logs Read', 'Logs Write', 'Access: Apps and Policies Read', 'Access: Apps and Policies Write', 'Access: Apps and Policies Revoke']
    const result = deriveOperationPolicies(Object.fromEntries(['/accounts/{account_id}', '/zones/{zone_id}', '/unknown/accounts/{account_id}'].map((path) => [path, { get: { 'x-api-token-group': labels } }])))
    expect(result[0].alternatives.map((item) => item.scopes[0])).toEqual(['account-logs.read', 'account-logs.write', 'access.read', 'access.write', 'access.revoke'])
    expect(result[2].alternatives.map((item) => item.scopes[0])).toEqual(['logs.read', 'logs.write', 'zone-access.read', 'zone-access.write', 'zone-access.revoke'])
    expect(result[1].alternatives.every((item) => item.unresolved)).toBe(true)
    const mixed = deriveOperationPolicies({ '/accounts/{account_id}/zones/{zone_id}': { get: { 'x-api-token-group': labels } } })[0]
    expect(mixed.alternatives.every((item) => item.unresolved)).toBe(true)
  })
  it('retains unknown alternatives and never infers a scope identifier', () => {
    const policy = deriveOperationPolicies({ '/accounts/{account_id}': { get: { 'x-api-token-group': ['Workers Scripts Read', 'Billing Read'] } } })[0]
    expect(policy.state).toBe('unresolved')
    expect(policy.alternatives[1]).toEqual({ label: 'Billing Read', scopes: [], unresolved: true })
    const proof = { ...policy, state: 'reviewed' as const, review: { source: 'test', version: '1' } }
    expect(evaluateOperationScopes(proof, [])).toEqual({ kind: 'unknown' })
    expect(evaluateOperationScopes(proof, ['workers-scripts.read'])).toEqual({ kind: 'allowed' })
  })
  it('selects one complete read alternative without unioning accepted groups', () => {
    const policy = policies.find((item) => item.method === 'GET')!
    const proof = { ...policy, state: 'reviewed' as const, review: { source: 'test', version: '1' } }
    expect(evaluateOperationScopes(proof, [])).toMatchObject({ kind: 'insufficient', scopes: ['workers-scripts.read'] })
    expect(evaluateOperationScopes(proof, ['workers-tail.read'])).toEqual({ kind: 'allowed' })
    expect(evaluateOperationScopes(policy, [])).toEqual({ kind: 'unknown' })
  })
  it('requires all scopes in a set and uses only explicit scope implications', () => {
    const policy = { ...reviewed(), alternatives: [{ label: 'test', scopes: ['dns.read', 'workers-scripts.read'], unresolved: false }] }
    expect(evaluateOperationScopes(policy, ['dns.write', 'workers-scripts.read'])).toMatchObject({ kind: 'insufficient' })
    expect(evaluateOperationScopes(policy, ['dns.write', 'workers-scripts.read'], { 'dns.write': ['dns.read'] })).toEqual({ kind: 'allowed' })
  })
  it('requires exact reviewed labels and valid identifiers, excluding offline access', () => {
    const source = { '/zones/{zone_id}/dns_records': paths['/zones/{zone_id}/dns_records'] }
    const rule = { method: 'POST', path: '/zones/{zone_id}/dns_records', labels: ['DNS Write'], anyOf: [['dns.write']], source: 'test', version: '1', rawSchemaHash: 'raw', catalogHash: 'catalog' }
    expect(deriveOperationPolicies(source, undefined, [rule])[0].state).toBe('reviewed')
    expect(deriveOperationPolicies(source, undefined, [{ ...rule, labels: ['Changed'] }])[0].state).toBe('candidate')
    expect(deriveOperationPolicies(source, undefined, [{ ...rule, anyOf: [['offline_access']] }])[0].state).toBe('candidate')
    expect(deriveOperationPolicies(source, undefined, [{ ...rule, anyOf: [['not-a-scope']] }])[0].state).toBe('candidate')
  })
  it('does not allow persisted or old artifacts to invent a deployment review', () => {
    const artifact = { version: 1 as const, resolverVersion: RESOLVER_VERSION as typeof RESOLVER_VERSION, rawSchemaHash: 'raw', catalogHash: 'catalog', operations: [reviewed()] }
    expect(deployedOperationPolicies(artifact)[0].state).toBe('candidate')
    expect(PolicyArtifact.safeParse({ version: 0, operations: [] }).success).toBe(false)
  })
})

describe('trusted route matching', () => {
  const base = 'https://api.cloudflare.com/client/v4'
  const policy = policies.find((item) => item.method === 'PUT')!
  const match = (path: string, method = 'PUT') => matchOperationPolicy(method, new URL(path, base), base, [policy])
  it('matches exact base path, parameters, query and a trailing slash', () => {
    expect(match('/client/v4/accounts/a/workers/scripts/hello%20world/?q=secret')).toBe(policy)
    expect(match('/other/client/v4/accounts/a/workers/scripts/name')).toBeUndefined()
    expect(match('/client/v4/accounts/a/workers/scripts/name', 'GET')).toBeUndefined()
  })
  it('rejects encoded separators, malformed decoding and ambiguous matches', () => {
    expect(match('/client/v4/accounts/a/workers/scripts/a%2fb')).toBeUndefined()
    expect(match('/client/v4/accounts/a/workers/scripts/a%5cb')).toBeUndefined()
    expect(match('/client/v4/accounts/a/workers/scripts/%zz')).toBeUndefined()
    const url = new URL('/client/v4/accounts/a/workers/scripts/name', base)
    expect(matchOperationPolicy('PUT', url, base, [policy, policy])).toBeUndefined()
  })
})

describe('request-local authorization', () => {
  it('accepts only verified provider identities, preserving direct credentials as unknown', () => {
    expect(verifiedScopeContext(auth)?.scope).toEqual(auth.scope)
    expect(verifiedScopeContext({ ...auth, userId: undefined, clientId: undefined, scope: [] })).toBeUndefined()
    expect(verifiedScopeContext({ type: 'user_token', scope: ['dns.write'] })).toBeUndefined()
  })
  it('creates a no-store safe challenge only for a recorded terminal denial', () => {
    const policy = reviewed()
    const controller = new ScopeController(verifiedScopeContext(auth), [policy], 'https://api.cloudflare.com/client/v4')
    expect(controller.terminalFailure('forged')).toBeUndefined()
    expect(controller.challenge(auth)).toBeUndefined()
    const decision = controller.beginDispatch(policy.method, 'https://api.cloudflare.com/client/v4/accounts/a/workers/scripts/test')
    expect(decision.allowed).toBe(false)
    expect(controller.challenge(auth)).toBeUndefined()
    if (!decision.allowed) controller.terminalFailure(decision.handle)
    const response = controller.challenge(auth)!
    expect(response.status).toBe(403)
    expect(response.headers.get('WWW-Authenticate')).toContain('/.well-known/oauth-protected-resource/mcp')
    expect(response.headers.get('WWW-Authenticate')).toContain('workers-scripts.write')
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(controller.beginDispatch('GET', 'https://api.cloudflare.com/client/v4/user').allowed).toBe(false)
  })
  it('blocks replay after any prior or parallel dispatch', () => {
    const policy = reviewed()
    const controller = new ScopeController(verifiedScopeContext(auth), [policy], 'https://api.cloudflare.com/client/v4')
    expect(controller.beginDispatch('GET', 'https://api.cloudflare.com/client/v4/user').allowed).toBe(true)
    const denied = controller.beginDispatch(policy.method, 'https://api.cloudflare.com/client/v4/accounts/a/workers/scripts/test')
    if (!denied.allowed) controller.terminalFailure(denied.handle)
    controller.finishDispatch()
    expect(controller.challenge(auth)).toBeUndefined()
  })
  it('preserves explicit empty grants while retaining the legacy absent-scope fallback', () => {
    expect(grantedScopes(['dns.write'], '')).toEqual([])
    expect(grantedScopes(['dns.write'], undefined)).toEqual(['dns.write'])
    expect(grantedScopes(['dns.write', 'dns.read'], 'dns.read')).toEqual(['dns.read'])
  })
})

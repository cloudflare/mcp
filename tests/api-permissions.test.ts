import { describe, expect, it } from 'vitest'
import {
  acceptedPermissions,
  connectionFromAuth,
  DIRECT_CONNECTION,
  explainRefusal,
  findOperation,
  scopeToRequest
} from '../src/api-permissions'

const oauth = (...scopes: string[]) => ({ kind: 'oauth' as const, scopes })

describe('connectionFromAuth', () => {
  it('reads the scopes of a token the provider issued', () => {
    expect(
      connectionFromAuth({ token: 't', audience: 'a', scope: ['dns.read'], clientId: 'c' })
    ).toEqual(oauth('dns.read'))
  })

  it('treats an externally resolved credential as direct', () => {
    expect(connectionFromAuth({ token: 't', audience: 'a', scope: [] })).toBe(DIRECT_CONNECTION)
    expect(connectionFromAuth(undefined)).toBe(DIRECT_CONNECTION)
  })
})

describe('acceptedPermissions', () => {
  it('returns the distinct permission names from x-api-token-group', () => {
    expect(acceptedPermissions({ 'x-api-token-group': ['Logs Read', 'Logs Read'] })).toEqual([
      'Logs Read'
    ])
  })

  it('returns undefined when the spec lists none', () => {
    expect(acceptedPermissions({})).toBeUndefined()
    expect(acceptedPermissions({ 'x-api-token-group': [] })).toBeUndefined()
    expect(acceptedPermissions(undefined)).toBeUndefined()
  })
})

describe('findOperation', () => {
  const paths = {
    '/zones/{zone_id}/rulesets/{ruleset_id}': { get: { summary: 'by id' } },
    '/zones/{zone_id}/rulesets/phases': { get: { summary: 'phases' } },
    '/zones/{zone_id}/dns_records': { get: { summary: 'list' } }
  }

  it('matches a concrete path to its template', () => {
    expect(findOperation(paths, 'GET', '/zones/abc/dns_records')?.operation.summary).toBe('list')
  })

  it('prefers the template with more literal segments', () => {
    expect(findOperation(paths, 'get', '/zones/abc/rulesets/phases')?.operation.summary).toBe(
      'phases'
    )
    expect(findOperation(paths, 'get', '/zones/abc/rulesets/r1')?.operation.summary).toBe('by id')
  })

  it('ignores a trailing slash and requires the method', () => {
    expect(findOperation(paths, 'GET', '/zones/abc/dns_records/')?.operation.summary).toBe('list')
    expect(findOperation(paths, 'POST', '/zones/abc/dns_records')).toBeUndefined()
  })
})

describe('explainRefusal', () => {
  const dns = ['DNS Read', 'DNS Write']

  it('says which scope to grant when the connection has none the endpoint accepts', () => {
    const text = explainRefusal(403, oauth('user:read', 'account:read'), dns)
    expect(text).toContain('was not granted a scope this endpoint accepts')
    expect(text).toContain('`dns.read` (DNS Read)')
    expect(text).toContain('`dns.write` (DNS Write)')
  })

  it('says reconnecting will not help when the connection already has an accepted scope', () => {
    const text = explainRefusal(403, oauth('dns.read'), dns)
    expect(text).toContain('already has `dns.read` (DNS Read)')
    expect(text).toContain('reconnecting will not help')
    expect(text).not.toContain('dns.write')
  })

  it('points OAuth connections to an API token when no OAuth scope covers the endpoint', () => {
    const text = explainRefusal(403, oauth('user:read'), ['Billing Read', 'Billing Write'])
    expect(text).toContain('No OAuth scope covers this endpoint')
    expect(text).toContain('Billing Read, Billing Write')
  })

  it('lists the permissions, with their OAuth scope IDs, for a direct credential', () => {
    const text = explainRefusal(403, DIRECT_CONNECTION, ['DNS Read', 'Billing Read'])
    expect(text).toBe(
      'This endpoint needs one of these permissions: DNS Read (`dns.read`), Billing Read. Add one to the token.'
    )
  })

  it('says a 403 is not a sign-in problem when the spec lists no permissions', () => {
    expect(explainRefusal(403, oauth('dns.read'), undefined)).toContain(
      'reconnecting with the same permissions will not help'
    )
  })

  it('decides a 401 by the scopes, like a 403, when the connection holds none the endpoint accepts', () => {
    expect(explainRefusal(401, oauth('user:read'), dns)).toContain(
      'was not granted a scope this endpoint accepts'
    )
    expect(
      scopeToRequest(401, oauth('user:read'), 'GET', '/zones/{zone_id}/dns_records', dns)
    ).toBe('dns.read')
  })

  it('uses the status only where the scopes cannot decide', () => {
    // Holds an accepted scope: 401 is a rejected credential, 403 is something else.
    expect(explainRefusal(401, oauth('dns.read'), dns)).toContain(
      'Cloudflare rejected the credential itself. Reconnect to sign in again.'
    )
    expect(explainRefusal(403, oauth('dns.read'), dns)).toContain('reconnecting will not help')
    // No permissions in the spec.
    expect(explainRefusal(401, oauth(), undefined)).toContain('Reconnect to sign in again')
    expect(explainRefusal(401, DIRECT_CONNECTION, undefined)).toContain('API token is valid')
    // A direct token's permissions are unknown, so a 401 lists what it needs too.
    expect(explainRefusal(401, DIRECT_CONNECTION, dns)).toBe(
      'This endpoint needs one of these permissions: DNS Read (`dns.read`), DNS Write (`dns.write`). Add one to the token. If the token already has one, check that it is valid and has not expired.'
    )
  })

  it('says nothing for other statuses', () => {
    expect(explainRefusal(404, oauth(), dns)).toBeUndefined()
    expect(explainRefusal(500, DIRECT_CONNECTION, dns)).toBeUndefined()
  })

  it('shortens long lists', () => {
    const many = Array.from({ length: 12 }, (_, index) => `Permission ${index}`)
    expect(explainRefusal(403, DIRECT_CONNECTION, many)).toContain('and 4 more')
  })
})

describe('scopeToRequest', () => {
  const lacking = oauth('user:read', 'account:read')
  const dns = ['DNS Read', 'DNS Write']

  it('asks for the read scope for a read and the write scope for a write', () => {
    expect(scopeToRequest(403, lacking, 'GET', '/zones/{zone_id}/dns_records', dns)).toBe(
      'dns.read'
    )
    expect(scopeToRequest(403, lacking, 'POST', '/zones/{zone_id}/dns_records', dns)).toBe(
      'dns.write'
    )
  })

  it('picks the account or zone variant of a permission from the path', () => {
    const access = ['Access: Apps and Policies Read']
    expect(scopeToRequest(403, lacking, 'GET', '/accounts/{account_id}/access/apps', access)).toBe(
      'access.read'
    )
    expect(scopeToRequest(403, lacking, 'GET', '/zones/{zone_id}/access/apps', access)).toBe(
      'zone-access.read'
    )
    const logs = ['Logs Read']
    expect(scopeToRequest(403, lacking, 'GET', '/accounts/{account_id}/logs/x', logs)).toBe(
      'account-logs.read'
    )
    expect(scopeToRequest(403, lacking, 'GET', '/zones/{zone_id}/logs/x', logs)).toBe('logs.read')
  })

  it('picks the alternative whose name matches the path', () => {
    const scripts = ['Workers Tail Read', 'Workers Scripts Write', 'Workers Scripts Read']
    expect(
      scopeToRequest(403, lacking, 'GET', '/accounts/{account_id}/workers/scripts', scripts)
    ).toBe('workers-scripts.read')
  })

  it('names no scope when alternatives tie', () => {
    expect(
      scopeToRequest(403, lacking, 'GET', '/accounts/{account_id}/thing', ['DNS Read', 'Zone Read'])
    ).toBeUndefined()
  })

  it('names no scope when a challenge would not help', () => {
    const path = '/zones/{zone_id}/dns_records'
    expect(scopeToRequest(403, oauth('dns.write'), 'GET', path, dns)).toBeUndefined()
    expect(scopeToRequest(403, DIRECT_CONNECTION, 'GET', path, dns)).toBeUndefined()
    expect(scopeToRequest(401, oauth('dns.read'), 'GET', path, dns)).toBeUndefined()
    expect(scopeToRequest(403, lacking, 'GET', path, ['Billing Read'])).toBeUndefined()
    expect(scopeToRequest(403, lacking, 'GET', path, undefined)).toBeUndefined()
  })
})

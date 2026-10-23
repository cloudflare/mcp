import { describe, expect, it } from 'vitest'
import {
  acceptedScopes,
  connectionFromAuth,
  authorize,
  DIRECT_CONNECTION,
  emptyListProvesNothing,
  explainRefusal,
  findOperation,
  type Connection,
  type EndpointAccess
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

describe('acceptedScopes', () => {
  it('returns the distinct OAuth scopes the security requirements list', () => {
    expect(
      acceptedScopes({
        security: [
          { api_token: [] },
          { cloudflare_oauth: ['d1.read'] },
          { cloudflare_oauth: ['d1.write'] },
          { cloudflare_oauth: ['d1.read'] }
        ]
      })
    ).toEqual(['d1.read', 'd1.write'])
  })

  it('returns undefined when the spec lists none', () => {
    expect(acceptedScopes({ security: [{ api_token: [] }] })).toBeUndefined()
    expect(acceptedScopes({ security: 'oauth' })).toBeUndefined()
    expect(acceptedScopes({})).toBeUndefined()
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

const DNS: EndpointAccess = {
  permissions: ['DNS Read', 'DNS Write'],
  scopes: ['dns.read', 'dns.write']
}
const BILLING: EndpointAccess = { permissions: ['Billing Read', 'Billing Write'] }
const DNS_PATH = '/zones/{zone_id}/dns_records'
const BASELINE = oauth('user:read', 'account:read')

/** Explain a refusal of `GET /zones/{zone_id}/dns_records` or another endpoint. */
function explain(
  status: 401 | 403,
  connection: Connection,
  access: EndpointAccess | undefined,
  path = DNS_PATH
): string {
  return explainRefusal(status, authorize(connection, { method: 'GET', path: path }, access))
}

describe('authorize', () => {
  it('grants a connection that holds a scope the endpoint accepts', () => {
    expect(authorize(oauth('dns.write'), { method: 'GET', path: DNS_PATH }, DNS)).toEqual({
      kind: 'granted',
      held: ['dns.write']
    })
  })

  it('names the read scope for a read and the write scope for a write', () => {
    expect(authorize(BASELINE, { method: 'GET', path: DNS_PATH }, DNS)).toEqual({
      kind: 'missing',
      options: ['dns.read', 'dns.write'],
      scope: 'dns.read'
    })
    expect(authorize(BASELINE, { method: 'POST', path: DNS_PATH }, DNS)).toMatchObject({
      scope: 'dns.write'
    })
  })

  it('picks the alternative whose name matches the path', () => {
    const scripts = {
      scopes: ['workers-tail.read', 'workers-scripts.write', 'workers-scripts.read']
    }
    expect(
      authorize(
        BASELINE,
        { method: 'GET', path: '/accounts/{account_id}/workers/scripts' },
        scripts
      )
    ).toMatchObject({ scope: 'workers-scripts.read' })
  })

  it('lists every option but names none when alternatives tie', () => {
    expect(
      authorize(
        BASELINE,
        { method: 'GET', path: '/accounts/{account_id}/thing' },
        {
          scopes: ['zone.read', 'dns.read']
        }
      )
    ).toEqual({ kind: 'missing', options: ['dns.read', 'zone.read'], scope: undefined })
  })

  it('cannot decide for a direct credential, an unlisted endpoint, or one OAuth cannot reach', () => {
    expect(authorize(DIRECT_CONNECTION, { method: 'GET', path: DNS_PATH }, DNS)).toEqual({
      kind: 'direct',
      permissions: DNS.permissions,
      scopes: DNS.scopes
    })
    expect(authorize(BASELINE, { method: 'GET', path: DNS_PATH }, undefined)).toEqual({
      kind: 'unlisted',
      connection: 'oauth'
    })
    expect(authorize(BASELINE, { method: 'GET', path: DNS_PATH }, BILLING)).toEqual({
      kind: 'unreachable',
      permissions: BILLING.permissions
    })
  })
})

describe('explainRefusal', () => {
  it('says which scope to grant when the connection has none the endpoint accepts', () => {
    const text = explain(403, BASELINE, DNS)
    expect(text).toContain('was not granted a scope this endpoint accepts')
    expect(text).toContain('`dns.read` (DNS Read)')
    expect(text).toContain('`dns.write` (DNS Write)')
  })

  it('says reconnecting will not help when the connection already has an accepted scope', () => {
    const text = explain(403, oauth('dns.read'), DNS)
    expect(text).toContain('already has `dns.read` (DNS Read)')
    expect(text).toContain('reconnecting will not help')
    expect(text).not.toContain('dns.write')
  })

  it('points OAuth connections to an API token when no OAuth scope covers the endpoint', () => {
    const text = explain(403, oauth('user:read'), BILLING)
    expect(text).toContain('No OAuth scope covers this endpoint')
    expect(text).toContain('Billing Read, Billing Write')
  })

  it('lists the permissions and the OAuth scopes for a direct credential', () => {
    expect(explain(403, DIRECT_CONNECTION, DNS)).toBe(
      'This endpoint needs one of these permissions: DNS Read, DNS Write (OAuth scopes: `dns.read`, `dns.write`). Add one to the token.'
    )
    expect(explain(403, DIRECT_CONNECTION, BILLING)).toBe(
      'This endpoint needs one of these permissions: Billing Read, Billing Write. Add one to the token.'
    )
  })

  it('says a 403 is not a sign-in problem when the spec lists no permissions', () => {
    expect(explain(403, oauth('dns.read'), undefined)).toContain(
      'reconnecting with the same permissions will not help'
    )
  })

  it('decides a 401 by the scopes, like a 403, when the connection holds none the endpoint accepts', () => {
    expect(explain(401, oauth('user:read'), DNS)).toContain(
      'was not granted a scope this endpoint accepts'
    )
  })

  it('uses the status only where the scopes cannot decide', () => {
    // Holds an accepted scope: 401 is a rejected credential, 403 is something else.
    expect(explain(401, oauth('dns.read'), DNS)).toContain(
      'Cloudflare rejected the credential itself. Reconnect to sign in again.'
    )
    expect(explain(403, oauth('dns.read'), DNS)).toContain('reconnecting will not help')
    // No permissions in the spec.
    expect(explain(401, oauth(), undefined)).toContain('Reconnect to sign in again')
    expect(explain(401, DIRECT_CONNECTION, undefined)).toContain('API token is valid')
    // A direct token's permissions are unknown, so a 401 lists what it needs too.
    expect(explain(401, DIRECT_CONNECTION, BILLING)).toBe(
      'This endpoint needs one of these permissions: Billing Read, Billing Write. Add one to the token. If the token already has one, check that it is valid and has not expired.'
    )
  })

  it('shortens long lists', () => {
    const many = Array.from({ length: 12 }, (_, index) => `Permission ${index}`)
    expect(explain(403, DIRECT_CONNECTION, { permissions: many })).toContain('and 4 more')
  })
})

describe('emptyListProvesNothing', () => {
  const doubts = (connection: Connection, access: EndpointAccess | undefined, method = 'GET') =>
    emptyListProvesNothing(
      method,
      authorize(connection, { method, path: DNS_PATH }, access),
      access?.permissions
    )

  it('doubts a read the connection holds no accepted scope for', () => {
    expect(doubts(BASELINE, DNS)).toBe(true)
  })

  it('trusts the list when the connection holds an accepted scope', () => {
    expect(doubts(oauth('dns.read'), DNS)).toBe(false)
  })

  it('trusts writes, direct credentials, and endpoints the decision cannot cover', () => {
    expect(doubts(BASELINE, DNS, 'POST')).toBe(false)
    expect(doubts(DIRECT_CONNECTION, DNS)).toBe(false)
    expect(doubts(BASELINE, undefined)).toBe(false)
    expect(doubts(BASELINE, BILLING)).toBe(false)
  })

  it('trusts endpoints the baseline scopes may grant', () => {
    // Measured: /accounts/{account_id}/members, /memberships and /user answer the baseline scopes.
    const scoped = (...permissions: string[]) => ({ permissions, scopes: ['some.read'] })
    expect(
      doubts(
        BASELINE,
        scoped('SCIM Provisioning', 'Account Settings Write', 'Account Settings Read')
      )
    ).toBe(false)
    expect(doubts(BASELINE, scoped('Memberships Write', 'Memberships Read'))).toBe(false)
    expect(doubts(BASELINE, scoped('User Details Write', 'User Details Read'))).toBe(false)
  })
})

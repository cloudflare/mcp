import { describe, expect, it } from 'vitest'
import {
  acceptedPermissions,
  connectionFromAuth,
  authorize,
  DIRECT_CONNECTION,
  emptyListProvesNothing,
  explainRefusal,
  findOperation,
  type Connection
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

const DNS = ['DNS Read', 'DNS Write']
const DNS_PATH = '/zones/{zone_id}/dns_records'
const BASELINE = oauth('user:read', 'account:read')

/** Explain a refusal of `GET /zones/{zone_id}/dns_records` or another endpoint. */
function explain(
  status: 401 | 403,
  connection: Connection,
  permissions: readonly string[] | undefined,
  path = DNS_PATH
): string {
  return explainRefusal(status, authorize(connection, { method: 'GET', path: path }, permissions))
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

  it('picks the account or zone variant of a permission from the path', () => {
    const access = ['Access: Apps and Policies Read']
    expect(
      authorize(BASELINE, { method: 'GET', path: '/accounts/{account_id}/access/apps' }, access)
    ).toMatchObject({
      options: ['access.read'],
      scope: 'access.read'
    })
    expect(
      authorize(BASELINE, { method: 'GET', path: '/zones/{zone_id}/access/apps' }, access)
    ).toMatchObject({
      options: ['zone-access.read'],
      scope: 'zone-access.read'
    })
    const logs = ['Logs Read']
    expect(
      authorize(BASELINE, { method: 'GET', path: '/accounts/{account_id}/logs/x' }, logs)
    ).toMatchObject({
      scope: 'account-logs.read'
    })
    expect(
      authorize(BASELINE, { method: 'GET', path: '/zones/{zone_id}/logs/x' }, logs)
    ).toMatchObject({
      scope: 'logs.read'
    })
  })

  it('does not count the other variant as held', () => {
    const access = ['Access: Apps and Policies Read']
    expect(
      authorize(
        oauth('zone-access.read'),
        { method: 'GET', path: '/accounts/{account_id}/access/apps' },
        access
      )
    ).toMatchObject({ kind: 'missing', scope: 'access.read' })
  })

  it('takes the variant from the request path when forge merges account and zone templates', () => {
    const access = ['Access: Apps and Policies Read']
    const template = '/{account_or_zone}/{account_or_zone_id}/access/apps'
    const zone = { method: 'GET', path: '/zones/z1/access/apps', template }
    const account = { method: 'GET', path: '/accounts/a1/access/apps', template }

    expect(authorize(oauth('zone-access.read'), zone, access)).toEqual({
      kind: 'granted',
      held: ['zone-access.read']
    })
    expect(authorize(BASELINE, zone, access)).toMatchObject({ scope: 'zone-access.read' })
    expect(authorize(oauth('zone-access.read'), account, access)).toMatchObject({
      kind: 'missing',
      scope: 'access.read'
    })
  })

  it('picks the alternative whose name matches the path', () => {
    const scripts = ['Workers Tail Read', 'Workers Scripts Write', 'Workers Scripts Read']
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
      authorize(BASELINE, { method: 'GET', path: '/accounts/{account_id}/thing' }, [
        'DNS Read',
        'Zone Read'
      ])
    ).toEqual({ kind: 'missing', options: ['dns.read', 'zone.read'], scope: undefined })
  })

  it('matches spec permission names that drifted from the catalog', () => {
    expect(
      authorize(BASELINE, { method: 'GET', path: '/zones' }, ['Zone Zone Read'])
    ).toMatchObject({
      kind: 'missing',
      scope: 'zone.read'
    })
    expect(
      authorize(BASELINE, { method: 'GET', path: '/accounts/{account_id}/browser-rendering/x' }, [
        'Browser Rendering Read'
      ])
    ).toMatchObject({ kind: 'missing', scope: 'browser-rendering.read' })
  })

  it('matches the dashboard-style names POST /zones lists', () => {
    expect(
      authorize(BASELINE, { method: 'POST', path: '/zones' }, ['Zone Zone Edit', 'Zone DNS Edit'])
    ).toMatchObject({ kind: 'missing', options: ['dns.write', 'zone.write'] })
  })

  it('cannot decide for a direct credential, an unlisted endpoint, or one OAuth cannot reach', () => {
    expect(authorize(DIRECT_CONNECTION, { method: 'GET', path: DNS_PATH }, DNS)).toEqual({
      kind: 'direct',
      permissions: DNS
    })
    expect(authorize(BASELINE, { method: 'GET', path: DNS_PATH }, undefined)).toEqual({
      kind: 'unlisted',
      connection: 'oauth'
    })
    expect(authorize(BASELINE, { method: 'GET', path: DNS_PATH }, ['Billing Read'])).toEqual({
      kind: 'unreachable',
      permissions: ['Billing Read']
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
    const text = explain(403, oauth('user:read'), ['Billing Read', 'Billing Write'])
    expect(text).toContain('No OAuth scope covers this endpoint')
    expect(text).toContain('Billing Read, Billing Write')
  })

  it('lists the permissions, with their OAuth scope IDs, for a direct credential', () => {
    expect(explain(403, DIRECT_CONNECTION, ['DNS Read', 'Billing Read'])).toBe(
      'This endpoint needs one of these permissions: DNS Read (`dns.read`), Billing Read. Add one to the token.'
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
    expect(explain(401, DIRECT_CONNECTION, DNS)).toBe(
      'This endpoint needs one of these permissions: DNS Read (`dns.read`), DNS Write (`dns.write`). Add one to the token. If the token already has one, check that it is valid and has not expired.'
    )
  })

  it('shortens long lists', () => {
    const many = Array.from({ length: 12 }, (_, index) => `Permission ${index}`)
    expect(explain(403, DIRECT_CONNECTION, many)).toContain('and 4 more')
  })
})

describe('emptyListProvesNothing', () => {
  const doubts = (connection: Connection, permissions: string[] | undefined, method = 'GET') =>
    emptyListProvesNothing(
      method,
      authorize(connection, { method, path: DNS_PATH }, permissions),
      permissions
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
    expect(doubts(BASELINE, ['Billing Read'])).toBe(false)
  })

  it('trusts endpoints the baseline scopes may grant', () => {
    // Measured: /accounts/{account_id}/members, /memberships and /user answer the baseline scopes.
    expect(
      doubts(BASELINE, ['SCIM Provisioning', 'Account Settings Write', 'Account Settings Read'])
    ).toBe(false)
    expect(doubts(BASELINE, ['Memberships Write', 'Memberships Read'])).toBe(false)
    expect(doubts(BASELINE, ['User Details Write', 'User Details Read'])).toBe(false)
  })
})

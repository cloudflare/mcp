import { describe, expect, it } from 'vitest'
import { tools } from '../src/generated/forge-mcp'
import { cloudflareTool } from '../src/forge-tools/cloudflare'
import { planCall, type PlanOptions } from '../src/forge-tools/plan'

const BASE = 'https://api.cloudflare.com/client/v4'
const ACCOUNT = '00000000000000000000000000000001'

function plan(name: string, args: Record<string, unknown>, options: Partial<PlanOptions> = {}) {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`no generated tool ${name}`)
  return planCall(cloudflareTool(tool), args, { baseUrl: BASE, ...options })
}

describe('planning a generated tool call', () => {
  it("fills in the session's account and carries the method's permissions", async () => {
    const result = await plan('d1_list', { query: { per_page: 5 } }, { sessionAccountId: ACCOUNT })

    expect(result).toMatchObject({
      kind: 'request',
      method: 'GET',
      url: `${BASE}/accounts/${ACCOUNT}/d1/database?per_page=5`,
      template: '/accounts/{account_id}/d1/database',
      accountId: ACCOUNT
    })
    expect(result.kind === 'request' && result.permissions).toContain('D1 Read')
    expect(result.kind === 'request' && result.headers).not.toHaveProperty('authorization')
  })

  it('asks for an account when the session has several, naming where it goes', async () => {
    expect(await plan('d1_list', {})).toEqual({
      kind: 'needs_account',
      argument: 'path.account_id'
    })
    expect(
      await plan('zeroTrust_access_applications_list', { path: { account_or_zone: 'accounts' } })
    ).toEqual({ kind: 'needs_account', argument: 'path.account_or_zone_id' })
  })

  it('refuses parameters passed at the top level, and says where they go', async () => {
    const result = await plan(
      'd1_list',
      { account_id: ACCOUNT, per_page: 5, verbose: true },
      { sessionAccountId: ACCOUNT }
    )

    expect(result).toEqual({
      kind: 'invalid',
      message:
        'Unknown arguments for d1_list: account_id goes in path: { "path": { "account_id": … } }; ' +
        'per_page goes in query: { "query": { "per_page": … } }; verbose is not an argument. ' +
        'It takes path, query.'
    })
  })

  it('keeps an account the caller passed, and sends the body', async () => {
    const result = await plan('d1_create', { path: { account_id: 'mine' }, body: { name: 'db' } })

    expect(result).toMatchObject({
      kind: 'request',
      method: 'POST',
      url: `${BASE}/accounts/mine/d1/database`,
      body: '{"name":"db"}',
      accountId: 'mine'
    })
  })

  it('fills in the account for a merged account-or-zone path called with accounts', async () => {
    const zone = await plan('zeroTrust_access_applications_list', {
      path: { account_or_zone: 'zones', account_or_zone_id: 'z1' }
    })
    const account = await plan(
      'zeroTrust_access_applications_list',
      { path: { account_or_zone: 'accounts' } },
      { sessionAccountId: ACCOUNT }
    )

    expect(zone).toMatchObject({
      url: `${BASE}/zones/z1/access/apps`,
      template: '/{account_or_zone}/{account_or_zone_id}/access/apps'
    })
    expect(zone.kind === 'request' && zone.accountId).toBeFalsy()
    expect(account).toMatchObject({
      url: `${BASE}/accounts/${ACCOUNT}/access/apps`,
      accountId: ACCOUNT
    })
  })

  it('reports arguments the request cannot be built from', async () => {
    expect(await plan('zones_get', {})).toEqual({
      kind: 'invalid',
      message: 'Missing required arguments: path'
    })
    expect(await plan('zones_get', { path: {} })).toEqual({
      kind: 'invalid',
      message: 'Missing required arguments: path.zone_id'
    })
    expect(await plan('zones_get', { path: 'z1' })).toEqual({
      kind: 'invalid',
      message: 'path must be an object'
    })
  })
})

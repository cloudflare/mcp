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

  it('refuses a misspelled parameter, naming it', async () => {
    const result = await plan('d1_list', { query: { nmae: 'db' } }, { sessionAccountId: ACCOUNT })

    expect(result).toMatchObject({ kind: 'invalid' })
    expect(result.kind === 'invalid' && result.message).toMatch(
      /^Input validation error: Invalid arguments for tool d1_list: .*Property "nmae" does not match additional properties schema/
    )
  })

  it('refuses a misplaced account_id, rather than asking for an account', async () => {
    const result = await plan('d1_list', { account_id: ACCOUNT })

    expect(result).toMatchObject({ kind: 'invalid' })
    expect(result.kind === 'invalid' && result.message).toContain(
      'Property "account_id" does not match additional properties schema'
    )
  })

  it('refuses parameters passed at the top level, naming each', async () => {
    const result = await plan(
      'd1_list',
      { account_id: ACCOUNT, per_page: 5, verbose: true },
      { sessionAccountId: ACCOUNT }
    )

    expect(result).toMatchObject({ kind: 'invalid' })
    for (const name of ['account_id', 'per_page', 'verbose']) {
      expect(result.kind === 'invalid' && result.message).toContain(
        `Property "${name}" does not match additional properties schema`
      )
    }
    const message = result.kind === 'invalid' ? result.message : ''
    expect(message).toContain('account_id goes in path: { "path": { "account_id": … } }.')
    expect(message).toContain('per_page goes in query: { "query": { "per_page": … } }.')
    expect(message).not.toContain('verbose goes in')
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
    const message = async (args: Record<string, unknown>) => {
      const result = await plan('zones_get', args)
      return result.kind === 'invalid' ? result.message : `not invalid: ${result.kind}`
    }

    expect(await message({})).toContain('Instance does not have required property "path"')
    expect(await message({ path: {} })).toContain(
      'Instance does not have required property "zone_id"'
    )
    expect(await message({ path: 'z1' })).toMatch(/^Input validation error: .*#\/path/)
    expect(await message({ path: { zone_id: '' } })).toBe('Missing path parameter: zone_id')
  })
})

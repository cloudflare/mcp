import { describe, expect, it } from 'vitest'
import { buildRequest, InvalidArguments, tools } from '../src/generated/forge-mcp'
import { cloudflareTool } from '../src/forge-tools/cloudflare'
import { planCall, type PlanOptions } from '../src/forge-tools/plan'

const BASE = 'https://api.cloudflare.com/client/v4'
const ACCOUNT = '00000000000000000000000000000001'

function plan(name: string, args: Record<string, unknown>, options: Partial<PlanOptions> = {}) {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`no generated tool ${name}`)
  return planCall(
    cloudflareTool(tool),
    args,
    { baseUrl: BASE, ...options },
    buildRequest,
    (error) => error instanceof InvalidArguments
  )
}

describe('planning a generated tool call', () => {
  it("fills in the session's account and carries the method's permissions", async () => {
    const result = await plan('d1_list', { per_page: 5 }, { sessionAccountId: ACCOUNT })

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

  it('asks for an account when the session has several', async () => {
    expect(await plan('d1_list', {})).toEqual({ kind: 'needs_account' })
  })

  it('keeps an account the caller passed, and sends the body', async () => {
    const result = await plan('d1_create', { account_id: 'mine', body: { name: 'db' } })

    expect(result).toMatchObject({
      kind: 'request',
      method: 'POST',
      url: `${BASE}/accounts/mine/d1/database`,
      body: '{"name":"db"}',
      accountId: 'mine'
    })
  })

  it('makes a merged account-or-zone template concrete', async () => {
    const zone = await plan('zero_trust_access_applications_list', {
      account_or_zone: 'zones',
      account_or_zone_id: 'z1'
    })
    const account = await plan(
      'zero_trust_access_applications_list',
      { account_or_zone: 'accounts' },
      { sessionAccountId: ACCOUNT }
    )

    expect(zone).toMatchObject({ template: '/zones/{zone_id}/access/apps' })
    expect(zone.kind === 'request' && zone.accountId).toBeFalsy()
    expect(account).toMatchObject({
      url: `${BASE}/accounts/${ACCOUNT}/access/apps`,
      template: '/accounts/{account_id}/access/apps',
      accountId: ACCOUNT
    })
  })

  it('reports arguments the request cannot be built from', async () => {
    expect(await plan('zones_get', {})).toEqual({
      kind: 'invalid',
      message: 'Missing required arguments: zone_id'
    })
  })
})

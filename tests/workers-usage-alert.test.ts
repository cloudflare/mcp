import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { periodsAsOf, roundLimit } from '../src/workers-usage-alert/periods'
import { API_BASE, cfError, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, modernMcpRequest, parseMcpResult } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'

const ACCOUNT = '023e105f4ecef8ad9ca31a8372d0c353'
const TOKEN = 'usage-alert-token'
const ALERTING = `${API_BASE}/accounts/${ACCOUNT}/alerting/v3`
const ALERTING_PERMISSIONS = { 'x-api-token-group': ['Notifications Read'] }

const day = (month: string, d: number, requests: number) => ({
  sum: { requests },
  dimensions: { date: `${month}-${String(d).padStart(2, '0')}` }
})
const october = Array.from({ length: 31 }, (_, i) => day('2026-10', i + 1, 100_000_000))
const november = Array.from({ length: 18 }, (_, i) => day('2026-11', i + 1, 90_000_000))

let graphqlBody: { query?: string; variables?: Record<string, unknown> } | undefined

function mockApi({
  graphql = () =>
    HttpResponse.json({
      data: { viewer: { accounts: [{ previous: october, current: november }] } },
      errors: null
    }),
  policies = () =>
    HttpResponse.json(
      cfSuccess([
        {
          id: 'p1',
          name: 'Workers above 4B',
          enabled: true,
          alert_type: 'billing_usage_alert',
          filters: { product: ['worker_requests'], limit: ['4000000000'] },
          mechanisms: { email: [{ id: 'private@example.com' }] }
        },
        { id: 'p2', name: 'errors', enabled: true, alert_type: 'workers_observability_alert' },
        { id: 'p3', name: 'errors 2', enabled: true, alert_type: 'workers_observability_alert' }
      ])
    )
}: {
  graphql?: () => Response
  policies?: () => Response
} = {}) {
  server.use(
    http.post(`${API_BASE}/graphql`, async ({ request }) => {
      graphqlBody = (await request.json()) as typeof graphqlBody
      return graphql()
    }),
    http.get(`${ALERTING}/available_alerts`, () =>
      HttpResponse.json(
        cfSuccess({
          Billing: [{ type: 'billing_usage_alert', display_name: 'Usage Based Billing' }]
        })
      )
    ),
    http.get(`${ALERTING}/policies`, policies)
  )
}

async function call(args: Record<string, unknown> = { as_of: '2026-11-18' }, url = MCP_URL) {
  const response = await exports.default.fetch(
    modernMcpRequest(TOKEN, 'tools/call', { name: 'workers_usage_alert', arguments: args }, { url })
  )
  return (
    (await parseMcpResult(response)) as {
      result?: {
        isError?: boolean
        structuredContent?: Record<string, unknown>
        content?: { text: string }[]
      }
    }
  ).result
}

beforeEach(async () => {
  graphqlBody = undefined
  await seedSpec({
    '/accounts/{account_id}/alerting/v3/available_alerts': { get: ALERTING_PERMISSIONS },
    '/accounts/{account_id}/alerting/v3/policies': { get: ALERTING_PERMISSIONS }
  })
  mockIdentityProbe({ accounts: [{ id: ACCOUNT, name: 'Usage Co' }] })
})

afterEach(async () => {
  await clearSpec()
  await clearKv(env.OAUTH_KV)
})

describe('periods', () => {
  it('reads the current month to date and the whole previous month', () => {
    expect(periodsAsOf('2026-11-18')).toEqual({
      current: { month: '2026-11', start: '2026-11-01', end: '2026-11-18', days: 30 },
      previous: { month: '2026-10', start: '2026-10-01', end: '2026-10-31', days: 31 }
    })
  })

  it('crosses the year', () => {
    expect(periodsAsOf('2026-01-05').previous).toEqual({
      month: '2025-12',
      start: '2025-12-01',
      end: '2025-12-31',
      days: 31
    })
  })

  it.each([
    [3_800_000_000, 3_750_000_000],
    [3_900_000_000, 4_000_000_000],
    [40_000_000, 50_000_000],
    [1, 25_000_000]
  ])('roundLimit(%d) is %d', (n, rounded) => {
    expect(roundLimit(n)).toBe(rounded)
  })
})

describe.each([
  ['Code Mode', MCP_URL],
  ['direct tools', `${MCP_URL}?codemode=false`]
])('workers_usage_alert (%s)', (_mode, url) => {
  it('previews usage, existing alerts and a suggested limit', async () => {
    mockApi()
    const result = await call({ as_of: '2026-11-18' }, url)

    expect(result?.isError).toBeUndefined()
    expect(result?.structuredContent).toMatchObject({
      kind: 'workers_usage_alert_preview',
      accountId: ACCOUNT,
      accountName: 'Usage Co',
      currentMonth: '2026-11',
      previousMonth: '2026-10',
      alertAvailable: true,
      existingAlerts: [{ id: 'p1', name: 'Workers above 4B', enabled: true, limit: 4_000_000_000 }],
      otherPolicies: { workers_observability_alert: 2 },
      // 3.1B in October, plus 25%, rounded.
      suggestedLimit: 4_000_000_000
    })
    expect(result?.structuredContent?.previous).toHaveLength(31)
    expect(result?.structuredContent?.current).toHaveLength(18)
    expect(JSON.stringify(result)).not.toContain('private@example.com')
    // An account token has no user, so the view has no default recipient.
    expect(result?.structuredContent).not.toHaveProperty('userEmail')
  })

  it('offers a user credential’s own email as the default recipient', async () => {
    mockIdentityProbe({
      user: { id: 'u1', email: 'me@example.com' },
      accounts: [{ id: ACCOUNT, name: 'Usage Co' }]
    })
    mockApi()
    const result = await call({ as_of: '2026-11-18' }, url)
    expect(result?.structuredContent).toMatchObject({ userEmail: 'me@example.com' })
  })
})

describe('workers_usage_alert reads', () => {
  it('queries each month separately, within the dataset’s widest range', async () => {
    mockApi()
    await call()
    expect(graphqlBody?.variables).toEqual({
      account: ACCOUNT,
      previousStart: '2026-10-01',
      previousEnd: '2026-10-31',
      currentStart: '2026-11-01',
      currentEnd: '2026-11-18'
    })
    expect(graphqlBody?.query).toContain('previous: workersInvocationsAdaptive')
  })

  it('is an error when usage cannot be read, naming the missing analytics permission', async () => {
    mockApi({
      graphql: () =>
        HttpResponse.json({ data: null, errors: [{ message: 'authorization denied' }] })
    })
    const result = await call()
    expect(result?.isError).toBe(true)
    expect(result?.content?.[0].text).toContain('Account Analytics Read')
  })

  it('passes a GraphQL quota error through as Cloudflare’s message', async () => {
    mockApi({
      graphql: () =>
        HttpResponse.json({
          data: null,
          errors: [{ message: 'cannot request a time range wider than 4w4d' }]
        })
    })
    const result = await call()
    expect(result?.isError).toBe(true)
    expect(result?.content?.[0].text).toContain('4w4d')
  })

  it('never reports a refused policy read as no existing alerts', async () => {
    mockApi({
      policies: () =>
        HttpResponse.json(cfError([{ code: 10000, message: 'Authentication error' }]), {
          status: 403
        })
    })
    const result = await call()
    expect(result?.isError).toBeUndefined()
    expect(result?.structuredContent).toMatchObject({ existingAlerts: null, alertAvailable: true })
    expect(JSON.stringify(result?.structuredContent?.limitations)).toContain(
      'Existing notification policies could not be read'
    )
  })

  it('notes a previous month with missing days', async () => {
    mockApi({
      graphql: () =>
        HttpResponse.json({
          data: { viewer: { accounts: [{ previous: october.slice(10), current: november }] } }
        })
    })
    const result = await call()
    expect(JSON.stringify(result?.structuredContent?.limitations)).toContain('21 of 31 days')
  })

  it('is an error when the account returns no analytics', async () => {
    mockApi({ graphql: () => HttpResponse.json({ data: { viewer: { accounts: [] } } }) })
    const result = await call()
    expect(result?.isError).toBe(true)
    expect(result?.content?.[0].text).toContain('No Workers analytics were returned')
  })

  it('serves its App resource without account data', async () => {
    const response = await exports.default.fetch(
      modernMcpRequest(TOKEN, 'resources/read', {
        uri: 'ui://cloudflare/workers-usage-alert.html'
      })
    )
    const body = JSON.stringify(await parseMcpResult(response))
    expect(body).toContain('text/html;profile=mcp-app')
    expect(body).not.toContain(ACCOUNT)
    expect(body).not.toContain(TOKEN)
  })
})

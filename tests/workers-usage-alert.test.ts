import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fillDays, historyWindows } from '../src/workers-usage-alert/history'
import { createPolicy, type CallTool } from '../src/workers-usage-alert/create'
import {
  deriveModel,
  monitorPolicy,
  replayEmails,
  rolling7,
  type Day
} from '../src/workers-usage-alert/model'
import { API_BASE, cfError, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, modernMcpRequest, parseMcpResult } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'

const ACCOUNT = '023e105f4ecef8ad9ca31a8372d0c353'
const TOKEN = 'usage-alert-token'
const ALERTING = `${API_BASE}/accounts/${ACCOUNT}/alerting/v3`
const ALERTING_PERMISSIONS = { 'x-api-token-group': ['Notifications Read'] }

const AS_OF = '2026-11-19'
const WINDOWS = historyWindows(AS_OF)
const row = (date: string, requests: number) => ({ sum: { requests }, dimensions: { date } })
/** Every day of each window at `requests`, as GraphQL returns it: one alias per window. */
const steady = (requests = 100_000_000) =>
  Object.fromEntries(
    WINDOWS.map((w, i) => {
      const rows = []
      for (let t = Date.parse(w.start); t <= Date.parse(w.end); t += 864e5)
        rows.push(row(new Date(t).toISOString().slice(0, 10), requests))
      return [`w${i}`, rows]
    })
  )

let graphqlBody: { query?: string; variables?: Record<string, unknown> } | undefined

function mockApi({
  graphql = () =>
    HttpResponse.json({
      data: { viewer: { accounts: [steady()] } },
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
        {
          id: 'p4',
          name: 'Workers requests over 1B in 7 days',
          enabled: false,
          alert_type: 'custom_analytics',
          filters: {
            selectors: ['SELECT COUNT(*) AS value FROM events.workersInvocations WHERE 1'],
            alert_trigger_preferences_value: ['1000000000']
          }
        },
        {
          id: 'p5',
          name: 'error anomaly',
          enabled: true,
          alert_type: 'custom_analytics',
          filters: { selectors: ['SELECT COUNT(*) AS value FROM logs.workersLogs'] }
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
          'Custom Analytics': [{ type: 'custom_analytics', display_name: 'Custom Alert' }]
        })
      )
    ),
    http.get(`${ALERTING}/policies`, policies)
  )
}

async function call(args: Record<string, unknown> = { as_of: AS_OF }, url = MCP_URL) {
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

describe('history', () => {
  it('reads the 89 complete days analytics keep, in ranges one alias accepts', () => {
    expect(historyWindows('2026-11-19')).toEqual([
      { start: '2026-08-22', end: '2026-09-20' },
      { start: '2026-09-21', end: '2026-10-20' },
      { start: '2026-10-21', end: '2026-11-18' }
    ])
  })

  it('starts at the first day with traffic and fills quiet days with 0', () => {
    const windows = [{ start: '2026-11-01', end: '2026-11-06' }]
    expect(
      fillDays(
        [
          ['2026-11-03', 5],
          ['2026-11-05', 7],
          ['2026-11-05', 1]
        ],
        windows
      )
    ).toEqual([
      ['2026-11-03', 5],
      ['2026-11-04', 0],
      ['2026-11-05', 8],
      ['2026-11-06', 0]
    ])
    expect(fillDays([['2026-11-02', 0]], windows)).toEqual([])
  })
})

describe('model', () => {
  const days = (values: number[], from = '2026-11-01'): Day[] =>
    values.map((n, i) => [new Date(Date.parse(from) + i * 864e5).toISOString().slice(0, 10), n])

  it('sums each 7 days, from the seventh day on', () => {
    expect([...rolling7(days([1, 1, 1, 1, 1, 1, 1, 10, 1])).values()]).toEqual([7, 16, 16])
  })

  it('replays the monitor: an email on first passing the line, then every 7 days while over', () => {
    const d = days([
      ...Array(7).fill(1),
      ...Array(16).fill(10),
      ...Array(7).fill(0),
      ...Array(7).fill(10)
    ])
    const sent = replayEmails(d, rolling7(d), 50)
    expect(sent.map((e) => [e.date, e.first])).toEqual([
      ['2026-11-12', true],
      ['2026-11-19', false],
      ['2026-12-05', true]
    ])
  })

  it('has no typical week under a week of history, or with no traffic', () => {
    expect(deriveModel(days([5, 5, 5]), '2026-11-04').typical).toBeNull()
    expect(deriveModel(days(Array(10).fill(0)), '2026-11-11').typical).toBeNull()
  })

  it('takes the mean for an account idle most days', () => {
    expect(deriveModel(days([0, 0, 0, 0, 0, 0, 70]), '2026-11-08').typical).toBe(70)
  })

  it('suggests a typical week plus a quarter, on the axis’s step', () => {
    const m = deriveModel(days(Array(28).fill(100_000_000)), '2026-11-29')
    expect(m.typical).toBe(700_000_000)
    expect(m.suggested).toBe(900_000_000)
  })

  it('fits the axis to normal weeks, not one far above the rest', () => {
    const d = days(
      [...Array(28).fill(10), ...Array(7).fill(1000), ...Array(7).fill(10)],
      '2026-10-05'
    )
    const m = deriveModel(d, '2026-11-16')
    expect(m.peak).toBe(7000)
    expect(m.base).toBeLessThan(1000)
  })
})

describe.each([
  ['Code Mode', MCP_URL],
  ['direct tools', `${MCP_URL}?codemode=false`]
])('workers_usage_alert (%s)', (_mode, url) => {
  it('previews usage, existing alerts and a suggested limit', async () => {
    mockApi()
    const result = await call({ as_of: AS_OF }, url)

    expect(result?.isError).toBeUndefined()
    expect(result?.structuredContent).toMatchObject({
      kind: 'workers_usage_alert_preview',
      accountId: ACCOUNT,
      accountName: 'Usage Co',
      today: AS_OF,
      alertAvailable: true,
      existingAlerts: [
        {
          id: 'p1',
          name: 'Workers above 4B',
          enabled: true,
          kind: 'billing',
          limit: 4_000_000_000
        },
        { id: 'p4', enabled: false, kind: 'monitor', limit: 1_000_000_000 }
      ],
      otherPolicies: { workers_observability_alert: 2, custom_analytics: 1 },
      // 100M a day: a 700M week, plus a quarter on the axis's step.
      summary: {
        typicalWeek: 700_000_000,
        last7Days: 700_000_000,
        busiestWeek: 700_000_000,
        suggestedLimit: 900_000_000
      }
    })
    const days = result?.structuredContent?.days as [string, number][]
    expect(days).toHaveLength(89)
    expect([days[0][0], days.at(-1)?.[0]]).toEqual(['2026-08-22', '2026-11-18'])
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
    const result = await call({ as_of: AS_OF }, url)
    expect(result?.structuredContent).toMatchObject({ userEmail: 'me@example.com' })
  })

  it('starts the threshold at a limit the user named', async () => {
    mockApi()
    const result = await call({ as_of: AS_OF, limit: 2_000_000_000 }, url)
    expect(result?.structuredContent).toMatchObject({ summary: { suggestedLimit: 2_000_000_000 } })
  })
})

describe('workers_usage_alert reads', () => {
  it('reads 89 days in one query, one alias per range the dataset accepts', async () => {
    mockApi()
    await call()
    expect(graphqlBody?.variables).toEqual({
      account: ACCOUNT,
      s0: '2026-08-22',
      e0: '2026-09-20',
      s1: '2026-09-21',
      e1: '2026-10-20',
      s2: '2026-10-21',
      e2: '2026-11-18'
    })
    expect(graphqlBody?.query).toContain('w2: workersInvocationsAdaptive')
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

  it('has no typical week or suggestion with under a week of traffic', async () => {
    mockApi({
      graphql: () =>
        HttpResponse.json({
          data: {
            viewer: {
              accounts: [{ w0: [], w1: [], w2: [row('2026-11-16', 40), row('2026-11-18', 2)] }]
            }
          }
        })
    })
    const result = await call()
    expect(result?.structuredContent).toMatchObject({
      days: [
        ['2026-11-16', 40],
        ['2026-11-17', 0],
        ['2026-11-18', 2]
      ],
      summary: { typicalWeek: null, suggestedLimit: null }
    })
    expect(JSON.stringify(result?.structuredContent?.limitations)).toContain('Only 3 days')
  })

  it('is no traffic, not an error, for an account with no Workers requests', async () => {
    mockApi({
      graphql: () =>
        HttpResponse.json({ data: { viewer: { accounts: [{ w0: [], w1: [], w2: [] }] } } })
    })
    const result = await call()
    expect(result?.isError).toBeUndefined()
    expect(result?.structuredContent).toMatchObject({ days: [], summary: { typicalWeek: null } })
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

describe.each([
  ['Code Mode', MCP_URL, ['alerting_policies_create', 'execute']],
  ['direct tools', `${MCP_URL}?codemode=false`, ['alerting_policies_create']]
])('Create alert (%s)', (_mode, url, expectedCalls) => {
  const policy = monitorPolicy(
    ACCOUNT,
    2_000_000_000,
    'me@example.com',
    'Workers requests over 2B in 7 days'
  )
  const tried: string[] = []
  const callTool: CallTool = async (c) => {
    tried.push(c.name)
    const response = await exports.default.fetch(modernMcpRequest(TOKEN, 'tools/call', c, { url }))
    const parsed = (await parseMcpResult(response)) as {
      result?: Awaited<ReturnType<CallTool>>
      error?: { message: string }
    }
    if (parsed.error) throw new Error(parsed.error.message)
    return parsed.result!
  }

  beforeEach(async () => {
    tried.length = 0
    await seedSpec({
      '/accounts/{account_id}/alerting/v3/policies': {
        post: { 'x-api-token-group': ['Notifications Write'] }
      }
    })
  })

  it('creates exactly the policy the App shows, with a tool the connection lists', async () => {
    let sent: unknown
    server.use(
      http.post(`${ALERTING}/policies`, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(cfSuccess({ id: 'a'.repeat(32) }))
      })
    )

    const result = await createPolicy(callTool, ACCOUNT, policy)

    expect(result).toEqual({ ok: true, id: 'a'.repeat(32) })
    expect(sent).toEqual(policy)
    expect(tried).toEqual(expectedCalls)
  })

  it("shows Cloudflare's refusal and doesn't try another tool", async () => {
    server.use(
      http.post(`${ALERTING}/policies`, () =>
        HttpResponse.json(
          cfError([
            { code: 17204, message: 'this account can have at most 5 custom analytics policies' }
          ]),
          { status: 400 }
        )
      )
    )

    const result = await createPolicy(callTool, ACCOUNT, policy)

    expect(result).toMatchObject({ ok: false })
    expect(result?.ok === false && result.error).toContain('at most 5 custom analytics policies')
    expect(tried).toEqual(expectedCalls)
  })
})

describe('createPolicy', () => {
  const policy = monitorPolicy(ACCOUNT, 1000, 'me@example.com', 'n')

  it('returns undefined when no create tool exists, so the App hands off to the chat', async () => {
    const result = await createPolicy(
      async (c) => ({
        isError: true,
        content: [{ type: 'text', text: `Tool ${c.name} not found` }]
      }),
      ACCOUNT,
      policy
    )

    expect(result).toBeUndefined()
  })
})

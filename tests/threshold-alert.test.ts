import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CALENDAR_MONTH,
  deriveModel,
  measured,
  replayEmails,
  type Day
} from '../src/threshold-alert/model'
import {
  PRESETS,
  WORKERS_REQUESTS_BILLING,
  WORKERS_REQUESTS_MONITOR,
  billingUsagePolicy,
  monitorPolicy,
  recogniseAmong
} from '../src/threshold-alert/presets'
import { createPolicy, type CallTool } from '../src/threshold-alert/create'
import { historyWindows } from '../src/workers-usage-alert/history'
import {
  BILLING_ALERT_TOOL_CONFIG,
  USAGE_ALERT_TOOL_CONFIG
} from '../src/workers-usage-alert/contract'
import { MCP_APPS } from '../src/mcp-apps/registry'
import { API_BASE, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, modernMcpRequest, parseMcpResult } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'
import { ROUTING_PROMPTS } from './fixtures/threshold-alert-prompts'

const ACCOUNT = '023e105f4ecef8ad9ca31a8372d0c353'
const TOKEN = 'threshold-alert-token'
const ALERTING = `${API_BASE}/accounts/${ACCOUNT}/alerting/v3`
const AS_OF = '2026-11-19'

const days = (values: number[], from: string): Day[] =>
  values.map((n, i) => [new Date(Date.parse(from) + i * 864e5).toISOString().slice(0, 10), n])

describe('monthly cadence', () => {
  it('measures the total since the month began, starting again each month', () => {
    const d = days([5, 5, 5, 1, 1], '2026-10-30')
    expect([...measured(d, CALENDAR_MONTH)]).toEqual([
      ['2026-10-30', 5],
      ['2026-10-31', 10],
      ['2026-11-01', 5],
      ['2026-11-02', 6],
      ['2026-11-03', 7]
    ])
  })

  it('replays one email the day a month passes the line, and none again that month', () => {
    const d = days([...Array(31).fill(10), ...Array(30).fill(2)], '2026-10-01')
    const sent = replayEmails(d, measured(d, CALENDAR_MONTH), 100, CALENDAR_MONTH)
    expect(sent).toEqual([{ date: '2026-10-10', first: true }])
  })

  it('draws calendar months, the current one estimated to its end', () => {
    const m = deriveModel(days(Array(50).fill(1000), '2026-10-01'), '2026-11-20', CALENDAR_MONTH)
    expect(m.weeks.map((w) => [w.start, w.length, w.partial])).toEqual([
      ['2026-10-01', 31, false],
      ['2026-11-01', 30, false]
    ])
    expect(m.weeks[1]).toMatchObject({ daysActual: 19, daysEstimate: 11, total: 30_000 })
    expect(m.current).toBe(19_000)
    expect(m.typical).toBeCloseTo(30_437.5)
  })

  it('suggests a tenth above the busiest month, so no month in the history would have emailed', () => {
    // 89 days from Aug 22: August is cut, September and October are whole.
    const d = days(
      [
        ...Array(10).fill(1000),
        ...Array(30).fill(1000),
        ...Array(31).fill(2000),
        ...Array(18).fill(1000)
      ],
      '2026-08-22'
    )
    const m = deriveModel(d, AS_OF, CALENDAR_MONTH)
    expect(m.weeks[0]).toMatchObject({ start: '2026-08-01', partial: true })
    expect(m.peak).toBe(62_000)
    expect(m.suggested).toBe(70_000)
    expect(replayEmails(d, m.rolling, m.suggested!, CALENDAR_MONTH)).toEqual([])
  })

  it('counts a month the window cuts as far as it was read, and this month projected to its end', () => {
    const cut = days([...Array(10).fill(9000), ...Array(79).fill(100)], '2026-08-22')
    const m = deriveModel(cut, AS_OF, CALENDAR_MONTH)
    expect(m.peak).toBe(90_000)
    expect(replayEmails(cut, m.rolling, m.suggested!, CALENDAR_MONTH)).toEqual([])

    const rising = days([...Array(71).fill(100), ...Array(18).fill(3000)], '2026-08-22')
    expect(deriveModel(rising, AS_OF, CALENDAR_MONTH).peak).toBe(90_000)
  })

  it('opens the line above every bar the chart draws, this month’s estimate included', () => {
    const m = deriveModel(
      days([...Array(61).fill(100), ...Array(19).fill(1000)], '2026-09-01'),
      '2026-11-20',
      CALENDAR_MONTH
    )
    const tallest = Math.max(...m.weeks.map((w) => w.total))
    expect(m.suggested).toBeGreaterThanOrEqual(tallest * 1.1)
  })

  it('starts this month at 0 on its first day', () => {
    const m = deriveModel(days(Array(31).fill(10), '2026-10-01'), '2026-11-01', CALENDAR_MONTH)
    expect(m.current).toBe(0)
  })
})

describe('presets', () => {
  it('builds the monitor exactly as the Workers usage alert always has', () => {
    expect(WORKERS_REQUESTS_MONITOR.policy(ACCOUNT, 5, 'a@example.com', 'n')).toEqual(
      monitorPolicy(ACCOUNT, 5, 'a@example.com', 'n')
    )
    expect(monitorPolicy(ACCOUNT, 5, 'a@example.com', 'n')).toMatchObject({
      alert_type: 'custom_analytics',
      alert_interval: '168h',
      filters: { alert_trigger_preferences_value: ['5'], execution_interval: ['1h'] }
    })
  })

  it('builds the billing alert the dashboard’s Usage Based Billing form sends', () => {
    expect(billingUsagePolicy(ACCOUNT, 50_000_000, 'a@example.com', 'n')).toEqual({
      name: 'n',
      alert_type: 'billing_usage_alert',
      enabled: true,
      filters: { product: ['worker_requests'], limit: ['50000000'] },
      mechanisms: { email: [{ id: 'a@example.com' }] }
    })
  })

  it('recognises each preset’s policies, and nothing else', () => {
    const presets = Object.values(PRESETS)
    expect(
      recogniseAmong(presets, {
        alert_type: 'billing_usage_alert',
        filters: { product: ['worker_requests'], limit: ['7'] }
      })
    ).toEqual({ kind: 'billing', limit: 7 })
    expect(
      recogniseAmong(presets, {
        alert_type: 'custom_analytics',
        filters: {
          selectors: ['SELECT 1 FROM events.workersInvocations'],
          alert_trigger_preferences_value: ['9']
        }
      })
    ).toEqual({ kind: 'monitor', limit: 9 })
    expect(
      recogniseAmong(presets, {
        alert_type: 'billing_usage_alert',
        filters: { product: ['r2_storage'], limit: ['7'] }
      })
    ).toBeNull()
    expect(
      recogniseAmong(presets, {
        alert_type: 'billing_budget_alert',
        filters: { total_spend_dollars: ['5'] }
      })
    ).toBeNull()
  })

  it('registers one App per preset, all writing with the same generated tools', () => {
    const tools = Object.values(PRESETS).map((p) => p.toolName)
    const apps = MCP_APPS.filter((app) => tools.includes(app.tool.name))
    expect(apps.map((a) => a.tool.name).sort()).toEqual([...tools].sort())
    for (const app of apps)
      expect(app.appTools.map((t) => t.name).sort()).toEqual([
        'alerting_policies_create',
        'alerting_policies_delete',
        'alerting_policies_update'
      ])
  })
})

describe('routing', () => {
  const described = {
    workers_usage_alert: USAGE_ALERT_TOOL_CONFIG.description,
    workers_billing_alert: BILLING_ALERT_TOOL_CONFIG.description
  }

  it('has prompts that should and shouldn’t reach each tool', () => {
    for (const route of ['workers_usage_alert', 'workers_billing_alert'] as const) {
      expect(ROUTING_PROMPTS.filter((p) => p.route === route).length).toBeGreaterThanOrEqual(3)
    }
    expect(ROUTING_PROMPTS.filter((p) => p.route === 'none').length).toBeGreaterThanOrEqual(2)
  })

  it('names its own example prompt and points to the other tool for the other kind', () => {
    expect(described.workers_usage_alert).toContain('way out of hand')
    expect(described.workers_usage_alert).toContain('use workers_billing_alert')
    expect(described.workers_billing_alert).toContain('bill passes 50M requests')
    expect(described.workers_billing_alert).toContain('use workers_usage_alert')
  })

  it('says neither blocks traffic nor measures dollars, so spend and caps route to neither', () => {
    for (const description of Object.values(described)) {
      expect(description).toMatch(/never blocks traffic/)
      expect(description).toMatch(/not (dollar cost|dollars)/)
      expect(description).toMatch(/dollar (spend|budget), neither/)
      expect(description).toMatch(/Don’t call it to shut off, pause, cap/)
    }
  })

  it('claims “is there a way to get told” questions about spikes, so they don’t go to a web search', () => {
    expect(described.workers_usage_alert).toContain('is there a way to get told')
    expect(described.workers_usage_alert).toContain('rather than searching the web')
  })
})

describe.each([
  ['Code Mode', MCP_URL],
  ['direct tools', `${MCP_URL}?codemode=false`]
])('workers_billing_alert (%s)', (_mode, url) => {
  let graphqlCalls = 0
  beforeEach(async () => {
    graphqlCalls = 0
    await seedSpec({
      '/accounts/{account_id}/alerting/v3/available_alerts': {
        get: { 'x-api-token-group': ['Notifications Read'] }
      },
      '/accounts/{account_id}/alerting/v3/policies': {
        get: { 'x-api-token-group': ['Notifications Read'] },
        post: { 'x-api-token-group': ['Notifications Write'] }
      }
    })
    mockIdentityProbe({ accounts: [{ id: ACCOUNT, name: 'Usage Co' }] })
    const windows = historyWindows(AS_OF)
    server.use(
      http.post(`${API_BASE}/graphql`, () => {
        graphqlCalls++
        const account = Object.fromEntries(
          windows.map((w, i) => {
            const rows = []
            for (let t = Date.parse(w.start); t <= Date.parse(w.end); t += 864e5)
              rows.push({
                sum: { requests: 1_000_000 },
                dimensions: { date: new Date(t).toISOString().slice(0, 10) }
              })
            return [`w${i}`, rows]
          })
        )
        return HttpResponse.json({ data: { viewer: { accounts: [account] } } })
      }),
      http.get(`${ALERTING}/available_alerts`, () =>
        HttpResponse.json(
          cfSuccess({
            Billing: [{ type: 'billing_usage_alert' }, { type: 'billing_budget_alert' }]
          })
        )
      ),
      http.get(`${ALERTING}/policies`, () =>
        HttpResponse.json(
          cfSuccess([
            {
              id: 'p1',
              name: 'Workers above 4B',
              enabled: true,
              alert_type: 'billing_usage_alert',
              filters: { product: ['worker_requests'], limit: ['4000000000'] }
            },
            {
              id: 'p2',
              name: 'Workers spike',
              enabled: true,
              alert_type: 'custom_analytics',
              filters: {
                selectors: ['SELECT COUNT(*) AS value FROM events.workersInvocations'],
                alert_trigger_preferences_value: ['9000000']
              }
            },
            { id: 'p3', name: 'budget', enabled: true, alert_type: 'billing_budget_alert' }
          ])
        )
      )
    )
  })

  afterEach(async () => {
    await clearSpec()
    await clearKv(env.OAUTH_KV)
  })

  async function call(name: string, args: Record<string, unknown>) {
    const response = await exports.default.fetch(
      modernMcpRequest(TOKEN, 'tools/call', { name, arguments: args }, { url })
    )
    return (
      (await parseMcpResult(response)) as {
        result?: { isError?: boolean; structuredContent?: Record<string, unknown> }
      }
    ).result
  }

  it('previews a monthly billing usage alert on the same 89 days', async () => {
    const result = await call('workers_billing_alert', { as_of: AS_OF })

    expect(result?.isError).toBeUndefined()
    expect(graphqlCalls).toBe(1)
    expect(result?.structuredContent).toMatchObject({
      kind: 'workers_billing_alert_preview',
      accountId: ACCOUNT,
      alertAvailable: true,
      existingAlerts: [
        { id: 'p1', kind: 'billing', limit: 4_000_000_000 },
        { id: 'p2', kind: 'monitor', limit: 9_000_000 }
      ],
      otherPolicies: { billing_budget_alert: 1 },
      // 1M a day: November so far is 18M; October is the busiest whole month, and a tenth above it rounds up to 36M on a 2M step.
      summary: { thisMonth: 18_000_000, busiestMonth: 31_000_000, suggestedLimit: 36_000_000 }
    })
    expect((result?.structuredContent?.days as unknown[]).length).toBe(89)
  })

  it('starts the threshold at a number the user named', async () => {
    const result = await call('workers_billing_alert', { as_of: AS_OF, limit: 50_000_000 })
    expect(result?.structuredContent).toMatchObject({ summary: { suggestedLimit: 50_000_000 } })
  })

  it('opens a tenth over the tallest bar when the named number is below it, and says why', async () => {
    const result = await call('workers_billing_alert', { as_of: AS_OF, limit: 10_000_000 })
    // October, 31M, is the tallest bar: 34.1M rounds up to 36M.
    expect(result?.structuredContent).toMatchObject({ summary: { suggestedLimit: 36_000_000 } })
    expect(JSON.stringify(result?.structuredContent?.limitations)).toContain(
      'would already have emailed'
    )
  })

  it('creates exactly the billing policy the card shows, with the same generated tool', async () => {
    let sent: unknown
    server.use(
      http.post(`${ALERTING}/policies`, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(cfSuccess({ id: 'd'.repeat(32) }))
      })
    )
    const callTool: CallTool = async (c) => {
      const response = await exports.default.fetch(
        modernMcpRequest(TOKEN, 'tools/call', c, { url })
      )
      return ((await parseMcpResult(response)) as { result: Awaited<ReturnType<CallTool>> }).result
    }
    const policy = WORKERS_REQUESTS_BILLING.policy(
      ACCOUNT,
      50_000_000,
      'me@example.com',
      WORKERS_REQUESTS_BILLING.name('50M')
    )

    const result = await createPolicy(callTool, ACCOUNT, policy)

    expect(result).toEqual({ status: 'done', id: 'd'.repeat(32) })
    expect(sent).toEqual({
      name: 'Billed Workers requests over 50M',
      alert_type: 'billing_usage_alert',
      enabled: true,
      filters: { product: ['worker_requests'], limit: ['50000000'] },
      mechanisms: { email: [{ id: 'me@example.com' }] }
    })
  })

  it('serves its own App resource, the shared view', async () => {
    const response = await exports.default.fetch(
      modernMcpRequest(TOKEN, 'resources/read', {
        uri: 'ui://cloudflare/workers-billing-alert.html'
      })
    )
    expect(JSON.stringify(await parseMcpResult(response))).toContain('text/html;profile=mcp-app')
  })
})

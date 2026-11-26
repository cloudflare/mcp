import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { historyWindows } from '../src/threshold-alert/history'
import {
  PRESETS,
  SPEND_POLICY,
  WORKERS_SPEND,
  actionOf,
  recogniseAmong
} from '../src/threshold-alert/presets'
import {
  createSetting,
  deleteSetting,
  updateSetting,
  type CallTool
} from '../src/threshold-alert/create'
import { exactNumber, policyNumber } from '../src/threshold-alert/units'
import { READ_ONLY_POSTS } from '../src/mcp-apps/api-read'
import { MCP_APPS } from '../src/mcp-apps/registry'
import { API_BASE, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, modernMcpRequest, parseMcpResult } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'

const ACCOUNT = '023e105f4ecef8ad9ca31a8372d0c353'
const TOKEN = 'workers-spend-limit-token'
const USAGE = `${API_BASE}/accounts/${ACCOUNT}/billable/usage`
const SPEND = `${API_BASE}/accounts/${ACCOUNT}/billing/spend-policies`
const AS_OF = '2026-11-19'
const POLICY_ID = '7c4e0a52-9f1b-4d6e-8a3c-2b5f1e9d0c7a'

describe('units', () => {
  it('writes cents as dollars, whole or with two digits, never localized', () => {
    expect(policyNumber(5000, 'cents')).toBe('$50')
    expect(policyNumber(4250, 'cents')).toBe('$42.50')
    expect(policyNumber(1_234_500, 'cents')).toBe('$12,345')
    expect(exactNumber(5000, 'cents')).toBe('5,000 cents ($50)')
  })
})

describe('workers-spend preset', () => {
  it('builds the spend policy the dashboard and cf send, for either action', () => {
    expect(WORKERS_SPEND.policy(ACCOUNT, 5000, 'a@example.com', 'notification')).toEqual({
      name: 'Workers spend over $50',
      product_id: 'workers',
      enabled: true,
      threshold_cents: 5000,
      action: 'notification',
      notification_email: 'a@example.com'
    })
    expect(WORKERS_SPEND.policy(ACCOUNT, 5000, 'a@example.com', 'usage_block')).toMatchObject({
      name: 'Workers spending limit $50',
      action: 'usage_block'
    })
  })

  it('starts on the email, and says what a limit stops before Create', () => {
    expect(actionOf(WORKERS_SPEND).id).toBe('notification')
    expect(actionOf(WORKERS_SPEND, 'usage_block').caution).toMatch(/every Worker/)
    expect(actionOf(WORKERS_SPEND, 'notification').caution).toBeUndefined()
    // An unknown choice falls back to the default rather than writing something else.
    expect(actionOf(WORKERS_SPEND, 'delete_everything').id).toBe('notification')
  })

  it('recognises Workers spend policies by action, and not Durable Objects or alerting ones', () => {
    const presets = Object.values(PRESETS)
    const spend = (product_id: string, action: string) => ({
      target: 'spend_policy' as const,
      product_id,
      action,
      threshold_cents: 900
    })
    expect(recogniseAmong(presets, spend('workers', 'usage_block'))).toEqual({
      kind: 'spend_limit',
      limit: 900
    })
    expect(recogniseAmong(presets, spend('workers', 'notification'))).toEqual({
      kind: 'spend_alert',
      limit: 900
    })
    expect(recogniseAmong(presets, spend('durable_objects', 'usage_block'))).toBeNull()
    expect(
      recogniseAmong([WORKERS_SPEND], {
        target: 'alerting_policy',
        alert_type: 'billing_usage_alert',
        filters: { product: ['worker_requests'], limit: ['5'] }
      })
    ).toBeNull()
  })

  it('writes with the spend policy tools, sending the version it was given as If-Match', () => {
    expect(WORKERS_SPEND.target).toBe(SPEND_POLICY)
    const body = WORKERS_SPEND.policy(ACCOUNT, 5000, 'a@example.com', 'notification')
    expect(SPEND_POLICY.update(ACCOUNT, { id: POLICY_ID, version: 3 }, body)).toEqual({
      name: 'billing_spendPolicies_update',
      arguments: {
        path: { account_id: ACCOUNT, policy_id: POLICY_ID },
        headers: { 'if-match': '3' },
        body
      }
    })
    expect(SPEND_POLICY.remove(ACCOUNT, { id: POLICY_ID, version: 4 })).toEqual({
      name: 'billing_spendPolicies_delete',
      arguments: {
        path: { account_id: ACCOUNT, policy_id: POLICY_ID },
        headers: { 'if-match': '4' }
      }
    })
  })

  it('lists the spend policy writes for the App only, and the billable usage query as a read', () => {
    const app = MCP_APPS.find((a) => a.tool.name === 'workers_spend_limit')
    expect(app?.appTools.map((t) => t.name).sort()).toEqual([...SPEND_POLICY.tools].sort())
    expect(READ_ONLY_POSTS).toEqual(['/accounts/{account_id}/billable/usage'])
  })
})

type CostRow = {
  ChargePeriodStart: string
  x_ProductFamilyName: string
  BilledCost: number
  BillingCurrency?: string
}

/**
 * Every day of a window, as the API answers a DAILY cost query: Workers at
 * $1.50 a day, and R2 at $9 a day, which the Workers policy doesn't count.
 */
function costDays(from: string, to: string, workers = 1.5): CostRow[] {
  const rows: CostRow[] = []
  for (let t = Date.parse(from); t < Date.parse(to); t += 864e5) {
    const day = new Date(t).toISOString()
    rows.push(
      { ChargePeriodStart: day, x_ProductFamilyName: 'Workers', BilledCost: workers },
      { ChargePeriodStart: day, x_ProductFamilyName: 'R2', BilledCost: 9 }
    )
  }
  return rows
}

describe.each([
  ['Code Mode', MCP_URL],
  ['direct tools', `${MCP_URL}?codemode=false`]
])('workers_spend_limit (%s)', (_mode, url) => {
  let queries: Array<Record<string, unknown>> = []

  beforeEach(async () => {
    queries = []
    await seedSpec({
      '/accounts/{account_id}/billable/usage': { get: {}, post: {} },
      '/accounts/{account_id}/billing/spend-policies': { get: {}, post: {} },
      '/accounts/{account_id}/billing/spend-policies/{policy_id}': {
        get: {},
        put: {},
        delete: {}
      }
    })
    mockIdentityProbe({ accounts: [{ id: ACCOUNT, name: 'Spend Co' }] })
    server.use(
      http.post(USAGE, async ({ request }) => {
        const body = (await request.json()) as {
          TimePeriod: { From: string; To: string }
        }
        queries.push(body)
        return HttpResponse.json(cfSuccess(costDays(body.TimePeriod.From, body.TimePeriod.To)))
      }),
      http.get(SPEND, () =>
        HttpResponse.json(
          cfSuccess([
            {
              id: POLICY_ID,
              name: 'Workers cap',
              enabled: true,
              product_id: 'workers',
              action: 'usage_block',
              threshold_cents: 20000,
              notification_email: 'ops@example.com',
              version: 2
            },
            {
              id: 'd0d0d0d0-0000-4000-8000-000000000000',
              name: 'DO alert',
              enabled: true,
              product_id: 'durable_objects',
              action: 'notification',
              threshold_cents: 500,
              notification_email: 'ops@example.com',
              version: 1
            }
          ])
        )
      )
    )
  })

  afterEach(async () => {
    await clearSpec()
    await clearKv(env.OAUTH_KV)
  })

  async function call(args: Record<string, unknown>) {
    const response = await exports.default.fetch(
      modernMcpRequest(
        TOKEN,
        'tools/call',
        { name: 'workers_spend_limit', arguments: args },
        { url }
      )
    )
    return (
      (await parseMcpResult(response)) as {
        result?: {
          isError?: boolean
          content?: { text?: string }[]
          structuredContent?: Record<string, unknown>
        }
      }
    ).result
  }

  it('reads daily Workers cost, one query per window the API accepts, in parallel', async () => {
    await call({ as_of: AS_OF })
    const windows = historyWindows(AS_OF)
    expect(queries).toHaveLength(windows.length)
    expect(queries[0]).toEqual({
      Metric: 'cost',
      Granularity: 'DAILY',
      TimePeriod: {
        From: `${windows[0].start}T00:00:00Z`,
        // `To` is exclusive: the day after the window's last.
        To: `${new Date(Date.parse(windows[0].end) + 864e5).toISOString().slice(0, 10)}T00:00:00Z`
      }
    })
  })

  it('previews a spend policy on Workers charges by month, in cents, counting only Workers', async () => {
    const result = await call({ as_of: AS_OF })

    expect(result?.isError).toBeUndefined()
    // $1.50 a day: a 31-day October is $46.50, November's 18 days so far $27.
    expect(result?.structuredContent).toMatchObject({
      kind: 'workers_spend_limit_preview',
      action: 'notification',
      alertAvailable: true,
      existingAlerts: [{ id: POLICY_ID, kind: 'spend_limit', limit: 20000, enabled: true }],
      otherPolicies: { 'spend_policy:durable_objects': 1 },
      summary: { thisMonth: 2700, busiestMonth: 4650 }
    })
    const days = result?.structuredContent?.days as [string, number][]
    expect(days).toHaveLength(89)
    expect(new Set(days.map(([, cents]) => cents))).toEqual(new Set([150]))
  })

  it('starts on a spending limit when the user asked to stop Workers', async () => {
    const result = await call({ as_of: AS_OF, action: 'usage_block', limit: 10000 })
    expect(result?.structuredContent).toMatchObject({
      action: 'usage_block',
      summary: { suggestedLimit: 10000 }
    })
  })

  it('is an error, naming Cloudflare’s refusal, when billable usage cannot be read', async () => {
    server.use(
      http.post(USAGE, () =>
        HttpResponse.json(
          {
            success: false,
            errors: [{ code: 10000, message: 'Authentication error' }],
            messages: [],
            result: null
          },
          { status: 403 }
        )
      )
    )
    const result = await call({ as_of: AS_OF })
    expect(result?.isError).toBe(true)
    expect(result?.content?.[0]?.text).toContain('/billable/usage')
    expect(result?.content?.[0]?.text).toContain('403')
  })

  it('still previews, noting it, when the spend policies cannot be read', async () => {
    server.use(
      http.get(SPEND, () =>
        HttpResponse.json(
          {
            success: false,
            errors: [{ code: 10000, message: 'Authentication error' }],
            messages: [],
            result: null
          },
          { status: 403 }
        )
      )
    )
    const result = await call({ as_of: AS_OF })
    expect(result?.isError).toBeUndefined()
    expect(result?.structuredContent).toMatchObject({ alertAvailable: null, existingAlerts: null })
    expect(JSON.stringify(result?.structuredContent?.limitations)).toContain(
      'Existing spend policies could not be read'
    )
  })

  it('creates, updates and deletes exactly the spend policy the card shows, carrying its version', async () => {
    const sent: Array<{ method: string; ifMatch: string | null; body: unknown }> = []
    const policy = (version: number, body: Record<string, unknown>) =>
      cfSuccess({ id: POLICY_ID, version, account_id: 1, ...body })
    server.use(
      http.post(SPEND, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        sent.push({ method: 'POST', ifMatch: null, body })
        return HttpResponse.json(policy(1, body), { status: 201 })
      }),
      http.put(`${SPEND}/${POLICY_ID}`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        sent.push({ method: 'PUT', ifMatch: request.headers.get('if-match'), body })
        return HttpResponse.json(policy(2, body))
      }),
      http.delete(`${SPEND}/${POLICY_ID}`, ({ request }) => {
        sent.push({ method: 'DELETE', ifMatch: request.headers.get('if-match'), body: null })
        return HttpResponse.json(cfSuccess({ id: POLICY_ID }))
      })
    )
    const callTool: CallTool = async (c) => {
      const response = await exports.default.fetch(
        modernMcpRequest(TOKEN, 'tools/call', { ...c }, { url, mcpApps: true })
      )
      return ((await parseMcpResult(response)) as { result: Awaited<ReturnType<CallTool>> }).result
    }
    const target = WORKERS_SPEND.target
    const limit = WORKERS_SPEND.policy(ACCOUNT, 5000, 'me@example.com', 'usage_block')

    const created = await createSetting(callTool, target, ACCOUNT, limit)
    expect(created).toEqual({ status: 'done', ref: { id: POLICY_ID, version: 1 } })
    if (created.status !== 'done' || !created.ref) throw new Error('not created')

    const raised = WORKERS_SPEND.policy(ACCOUNT, 8000, 'me@example.com', 'usage_block')
    const updated = await updateSetting(callTool, target, ACCOUNT, created.ref, raised)
    expect(updated).toEqual({ status: 'done', ref: { id: POLICY_ID, version: 2 } })
    if (updated.status !== 'done' || !updated.ref) throw new Error('not updated')

    expect(await deleteSetting(callTool, target, ACCOUNT, updated.ref)).toMatchObject({
      status: 'done'
    })
    expect(sent).toEqual([
      { method: 'POST', ifMatch: null, body: limit },
      { method: 'PUT', ifMatch: '1', body: raised },
      { method: 'DELETE', ifMatch: '2', body: null }
    ])
    expect(limit).toMatchObject({ action: 'usage_block', threshold_cents: 5000 })
  })

  it('serves its own App resource, the shared view', async () => {
    const response = await exports.default.fetch(
      modernMcpRequest(TOKEN, 'resources/read', { uri: 'ui://cloudflare/workers-spend-limit.html' })
    )
    expect(JSON.stringify(await parseMcpResult(response))).toContain('text/html;profile=mcp-app')
  })
})

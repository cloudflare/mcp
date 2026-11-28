import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { historyWindows } from '../src/threshold-alert/history'
import { ALIAS_LIMIT } from '../src/r2-storage-alert/read'
import { recogniseAmong, R2_STORAGE_BILLING, PRESETS } from '../src/threshold-alert/presets'
import { exactNumber, policyNumber } from '../src/threshold-alert/units'
import { createPolicy, type CallTool } from '../src/threshold-alert/create'
import { API_BASE, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, modernMcpRequest, parseMcpResult } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'

const ACCOUNT = '023e105f4ecef8ad9ca31a8372d0c353'
const TOKEN = 'r2-storage-alert-token'
const ALERTING = `${API_BASE}/accounts/${ACCOUNT}/alerting/v3`
const AS_OF = '2026-11-19'
const TB = 1e12

describe('units', () => {
  it('names a byte threshold in decimal units, as R2 bills, never localized', () => {
    expect(policyNumber(1.5 * TB, 'bytes')).toBe('1.5 TB')
    expect(policyNumber(250e9, 'bytes')).toBe('250 GB')
    expect(policyNumber(1_350_000_000, 'count')).toBe('1.35B')
    expect(exactNumber(2 * TB, 'bytes')).toBe('2,000,000,000,000 bytes (2 TB)')
  })
})

describe('r2-storage-billing preset', () => {
  it('builds the billing alert the dashboard sends for R2 storage, its limit in bytes', () => {
    expect(R2_STORAGE_BILLING.policy(ACCOUNT, 2 * TB, 'a@example.com', 'alert')).toEqual({
      name: 'Billed R2 storage over 2 TB',
      alert_type: 'billing_usage_alert',
      enabled: true,
      filters: { product: ['r2_storage'], limit: ['2000000000000'] },
      mechanisms: { email: [{ id: 'a@example.com' }] }
    })
    expect(R2_STORAGE_BILLING.name(policyNumber(2 * TB, 'bytes'), 'alert')).toBe(
      'Billed R2 storage over 2 TB'
    )
  })

  it('recognises R2 storage policies, and not Workers ones', () => {
    expect(
      recogniseAmong(Object.values(PRESETS), {
        target: 'alerting_policy',
        alert_type: 'billing_usage_alert',
        filters: { product: ['r2_storage'], limit: ['5000000000000'] }
      })
    ).toEqual({ kind: 'billing', limit: 5 * TB })
    expect(
      recogniseAmong([R2_STORAGE_BILLING], {
        target: 'alerting_policy',
        alert_type: 'billing_usage_alert',
        filters: { product: ['worker_requests'], limit: ['1'] }
      })
    ).toBeNull()
  })
})

type Row = {
  max: { payloadSize: number; metadataSize: number }
  dimensions: { date: string; bucketName: string }
}

/** Two buckets, each day: 600 GB + 300 GB stored, metadata included. */
const twoBuckets = (date: string): Row[] => [
  { max: { payloadSize: 600e9, metadataSize: 0 }, dimensions: { date, bucketName: 'a' } },
  { max: { payloadSize: 299e9, metadataSize: 1e9 }, dimensions: { date, bucketName: 'b' } }
]

/** Every day of each window, as GraphQL returns it: one alias per window. */
const answer = (rows: (date: string) => Row[] = twoBuckets) =>
  Object.fromEntries(
    historyWindows(AS_OF).map((w, i) => {
      const out: Row[] = []
      for (let t = Date.parse(w.start); t <= Date.parse(w.end); t += 864e5)
        out.push(...rows(new Date(t).toISOString().slice(0, 10)))
      // As the API does: no more rows than the alias's limit.
      return [`w${i}`, out.slice(0, ALIAS_LIMIT)]
    })
  )

describe.each([
  ['Code Mode', MCP_URL],
  ['direct tools', `${MCP_URL}?codemode=false`]
])('r2_storage_alert (%s)', (_mode, url) => {
  let graphql: { query?: string; variables?: Record<string, unknown> } | undefined

  beforeEach(async () => {
    graphql = undefined
    await seedSpec({
      '/accounts/{account_id}/alerting/v3/available_alerts': {
        get: { 'x-api-token-group': ['Notifications Read'] }
      },
      '/accounts/{account_id}/alerting/v3/policies': {
        get: { 'x-api-token-group': ['Notifications Read'] },
        post: { 'x-api-token-group': ['Notifications Write'] }
      }
    })
    mockIdentityProbe({ accounts: [{ id: ACCOUNT, name: 'Storage Co' }] })
    server.use(
      http.post(`${API_BASE}/graphql`, async ({ request }) => {
        graphql = (await request.json()) as typeof graphql
        return HttpResponse.json({ data: { viewer: { accounts: [answer()] } } })
      }),
      http.get(`${ALERTING}/available_alerts`, () =>
        HttpResponse.json(cfSuccess({ Billing: [{ type: 'billing_usage_alert' }] }))
      ),
      http.get(`${ALERTING}/policies`, () =>
        HttpResponse.json(
          cfSuccess([
            {
              id: 'p1',
              name: 'R2 over 5 TB',
              enabled: true,
              alert_type: 'billing_usage_alert',
              filters: { product: ['r2_storage'], limit: ['5000000000000'] }
            },
            {
              id: 'p2',
              name: 'Workers above 4B',
              enabled: true,
              alert_type: 'billing_usage_alert',
              filters: { product: ['worker_requests'], limit: ['4000000000'] }
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
      modernMcpRequest(TOKEN, 'tools/call', { name: 'r2_storage_alert', arguments: args }, { url })
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

  it('reads Standard storage per bucket per day, one alias per range the dataset accepts', async () => {
    await call({ as_of: AS_OF })
    expect(graphql?.query).toContain('r2StorageAdaptiveGroups')
    expect(graphql?.query).toContain('storageClass: "Standard"')
    expect(graphql?.query).toContain('dimensions { date bucketName }')
    expect(graphql?.query).toContain(`limit: ${ALIAS_LIMIT}`)
    expect(graphql?.query?.match(/r2StorageAdaptiveGroups/g)?.length).toBe(
      historyWindows(AS_OF).length
    )
  })

  it('previews a monthly billing alert on storage averaged as billing averages it', async () => {
    const result = await call({ as_of: AS_OF })

    expect(result?.isError).toBeUndefined()
    // 900 GB stored every day: each day counts 30 GB, so a 31-day October averages 930 GB, and
    // November's 18 days so far 540 GB.
    expect(result?.structuredContent).toMatchObject({
      kind: 'r2_storage_alert_preview',
      alertAvailable: true,
      existingAlerts: [{ id: 'p1', kind: 'billing', limit: 5 * TB }],
      otherPolicies: { billing_usage_alert: 1 },
      summary: { storedNow: 900e9, thisMonth: 540e9, busiestMonth: 930e9 }
    })
    const days = result?.structuredContent?.days as [string, number][]
    expect(days).toHaveLength(89)
    expect(days[0][1]).toBe(30e9)
    const { suggestedLimit } = result?.structuredContent?.summary as { suggestedLimit: number }
    expect(suggestedLimit).toBeGreaterThanOrEqual(930e9 * 1.1)
  })

  it('names a replaced amount in bytes and TB for the model', async () => {
    const result = await call({ as_of: AS_OF, limit: 1 })
    expect(JSON.stringify(result?.structuredContent?.limitations)).toContain(
      'not at the number named (1 bytes'
    )
  })

  it('says so when an alias came back full, since dropped buckets would read as less storage', async () => {
    server.use(
      http.post(`${API_BASE}/graphql`, () =>
        HttpResponse.json({
          data: {
            viewer: {
              accounts: [
                answer((date) =>
                  Array.from({ length: 70 }, (_, b) => ({
                    max: { payloadSize: 1e9, metadataSize: 0 },
                    dimensions: { date, bucketName: `b${b}` }
                  }))
                )
              ]
            }
          }
        })
      )
    )
    const result = await call({ as_of: AS_OF })
    expect(JSON.stringify(result?.structuredContent?.limitations)).toContain(
      'more buckets than one storage read returns'
    )
  })

  it('is an error, naming the missing analytics permission, when storage cannot be read', async () => {
    server.use(
      http.post(`${API_BASE}/graphql`, () =>
        HttpResponse.json({ data: null, errors: [{ message: 'authorization denied' }] })
      )
    )
    const result = await call({ as_of: AS_OF })
    expect(result?.isError).toBe(true)
    expect(result?.content?.[0]?.text).toContain('Account Analytics Read')
  })

  it('creates exactly the R2 storage policy the card shows, with the same generated tool', async () => {
    let sent: unknown
    server.use(
      http.post(`${ALERTING}/policies`, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json(cfSuccess({ id: 'e'.repeat(32) }))
      })
    )
    const callTool: CallTool = async (c) => {
      const response = await exports.default.fetch(
        modernMcpRequest(TOKEN, 'tools/call', { ...c }, { url, mcpApps: true })
      )
      return ((await parseMcpResult(response)) as { result: Awaited<ReturnType<CallTool>> }).result
    }
    const policy = R2_STORAGE_BILLING.policy(ACCOUNT, 2 * TB, 'me@example.com', 'alert')
    expect(await createPolicy(callTool, ACCOUNT, policy)).toEqual({
      status: 'done',
      ref: { id: 'e'.repeat(32) }
    })
    expect(sent).toMatchObject({
      name: 'Billed R2 storage over 2 TB',
      filters: { product: ['r2_storage'], limit: ['2000000000000'] }
    })
  })

  it('serves its own App resource, the shared view', async () => {
    const response = await exports.default.fetch(
      modernMcpRequest(TOKEN, 'resources/read', { uri: 'ui://cloudflare/r2-storage-alert.html' })
    )
    expect(JSON.stringify(await parseMcpResult(response))).toContain('text/html;profile=mcp-app')
  })
})

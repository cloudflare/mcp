import { env } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ATTENTION_TOOL, runAttentionTool } from '../../src/apps/attention/tool'
import { AttentionReportSchema } from '../../src/apps/attention/report'
import { AUTH_PROPS_VERSION, type AuthProps } from '../../src/auth/types'
import { API_BASE, cfError, cfSuccess, mockIdentityProbe } from '../helpers/cloudflare-api'
import { clearKv } from '../helpers/kv'
import { modernMcpRequest, parseMcpResult } from '../helpers/mcp'
import { clearSpec, seedSpec } from '../helpers/spec'
import { server } from '../setup/msw'
import { exports } from 'cloudflare:workers'

const ACCOUNT_ID = '023e105f4ecef8ad9ca31a8372d0c353'
const OTHER_ACCOUNT_ID = 'aaaabbbbccccddddeeeeffff00001111'
const NOW = new Date('2026-10-10T12:00:00Z')
const ACCOUNT_PATH = `${API_BASE}/accounts/${ACCOUNT_ID}`

const singleAccount: AuthProps = {
  type: 'user_token',
  accessToken: 'user-token',
  user: { id: 'user-1', email: 'alice@example.com' },
  accounts: [{ id: ACCOUNT_ID, name: 'Alice Co' }],
  version: AUTH_PROPS_VERSION
}

const multiAccount: AuthProps = {
  ...singleAccount,
  accounts: [
    { id: ACCOUNT_ID, name: 'Alice Co' },
    { id: OTHER_ACCOUNT_ID, name: 'Side Project' }
  ]
}

const ALERT = {
  id: 'alert-1',
  name: 'Origin error rate',
  alert_type: 'http_alert_origin_error',
  alert_body: '5xx rate above 5% on example.com',
  sent: '2026-10-10T11:00:00Z'
}

const INSIGHT = {
  id: 'insight-1',
  subject: 'example.com',
  issue_type: 'insecure_configuration',
  issue_class: 'always_use_https_not_enabled',
  severity: 'Critical',
  resolve_text: 'Turn on Always Use HTTPS',
  resolve_link: 'https://dash.cloudflare.com/example/ssl-tls/edge-certificates',
  timestamp: '2026-10-09T08:00:00Z'
}

const WORKERS_ISSUE = {
  id: 'issue-1',
  service: 'checkout',
  title: 'TypeError: cannot read properties of undefined',
  count: 42,
  lastObserved: Date.parse('2026-10-10T11:30:00Z')
}

function mockFeeds(
  overrides: Partial<Record<'alerts' | 'security' | 'workers', () => Response>> = {}
) {
  const seen: Record<string, URL> = {}
  server.use(
    http.get(`${ACCOUNT_PATH}/alerting/v3/history`, ({ request }) => {
      seen.alerts = new URL(request.url)
      return overrides.alerts?.() ?? HttpResponse.json(cfSuccess([ALERT]))
    }),
    http.get(`${ACCOUNT_PATH}/security-center/insights`, ({ request }) => {
      seen.security = new URL(request.url)
      return (
        overrides.security?.() ??
        HttpResponse.json(cfSuccess({ issues: [INSIGHT], count: 1, page: 1, per_page: 25 }))
      )
    }),
    http.get(`${ACCOUNT_PATH}/workers/observability/issues`, ({ request }) => {
      seen.workers = new URL(request.url)
      return overrides.workers?.() ?? HttpResponse.json(cfSuccess([WORKERS_ISSUE]))
    })
  )
  return seen
}

function reportOf(result: Awaited<ReturnType<typeof runAttentionTool>>) {
  return AttentionReportSchema.parse(result.structuredContent)
}

describe('show_attention definition', () => {
  it('is a read-only tool', () => {
    expect(ATTENTION_TOOL).toMatchObject({
      name: 'show_attention',
      annotations: { readOnlyHint: true, destructiveHint: false }
    })
  })

  it('asks only for read scopes', () => {
    const [scheme] = ATTENTION_TOOL._meta?.securitySchemes as Array<{ scopes: string[] }>
    expect(scheme.scopes.every((scope) => scope.endsWith('.read'))).toBe(true)
  })
})

describe('show_attention result', () => {
  it('merges all three feeds, most severe first', async () => {
    mockFeeds()
    const report = reportOf(await runAttentionTool(singleAccount, {}, NOW))

    expect(report.unavailable).toEqual([])
    expect(report.items.map((item) => item.id)).toEqual([
      'security:insight-1',
      'workers:issue-1',
      'alert:alert-1'
    ])
    expect(report.items[0]).toMatchObject({
      severity: 'critical',
      title: 'insecure configuration on example.com',
      link: INSIGHT.resolve_link
    })
    expect(report.items[1].observedAt).toBe('2026-10-10T11:30:00.000Z')
  })

  it('asks each feed only for what needs action', async () => {
    const seen = mockFeeds()
    await runAttentionTool(singleAccount, {}, NOW)

    expect(seen.alerts.searchParams.get('since')).toBe('2026-10-03T12:00:00.000Z')
    expect(seen.security.searchParams.get('dismissed')).toBe('false')
    expect(seen.workers.searchParams.get('status')).toBe('active')
  })

  it('links only to the Cloudflare dashboard', async () => {
    mockFeeds({
      security: () =>
        HttpResponse.json(
          cfSuccess({
            issues: [
              { ...INSIGHT, id: 'a', resolve_link: 'https://evil.example/phish' },
              { ...INSIGHT, id: 'b', resolve_link: 'javascript:alert(1)' }
            ]
          })
        )
    })
    const report = reportOf(await runAttentionTool(singleAccount, {}, NOW))

    expect(
      report.items.filter((item) => item.source === 'security').map((item) => item.link)
    ).toEqual([undefined, undefined])
  })

  it('resolves the relative dashboard links Security Center returns', async () => {
    mockFeeds({
      security: () =>
        HttpResponse.json(
          cfSuccess({
            issues: [
              { ...INSIGHT, id: 'a', resolve_link: '/:account_id/turnstile' },
              { ...INSIGHT, id: 'b', resolve_link: '/profile/authentication' }
            ]
          })
        )
    })
    const report = reportOf(await runAttentionTool(singleAccount, {}, NOW))

    expect(
      report.items.filter((item) => item.source === 'security').map((item) => item.link)
    ).toEqual([
      `https://dash.cloudflare.com/${ACCOUNT_ID}/turnstile`,
      'https://dash.cloudflare.com/profile/authentication'
    ])
  })

  it('replaces untranslated dashboard keys with the insight class', async () => {
    mockFeeds({
      security: () =>
        HttpResponse.json(
          cfSuccess({
            issues: [
              {
                ...INSIGHT,
                issue_class: 'mfa_not_enabled',
                resolve_text: 'security_center.checks.mfa.resolution_button'
              }
            ]
          })
        )
    })
    const report = reportOf(await runAttentionTool(singleAccount, {}, NOW))
    const insight = report.items.find((item) => item.source === 'security')

    expect(insight?.detail).toBe('mfa not enabled')
    expect(insight?.followUp).not.toContain('security_center.')
  })

  it('writes the Workers issue count and time for people to read', async () => {
    mockFeeds({
      workers: () =>
        HttpResponse.json(
          cfSuccess([
            { ...WORKERS_ISSUE, id: 'many', count: 527069 },
            { ...WORKERS_ISSUE, id: 'one', count: 1 }
          ])
        )
    })
    const report = reportOf(await runAttentionTool(singleAccount, {}, NOW))
    const details = report.items
      .filter((item) => item.source === 'workers')
      .map((item) => item.detail)

    expect(details).toEqual([
      'Seen 527,069 times, last on Oct 10, 2026, 11:30 AM UTC.',
      'Seen once, last on Oct 10, 2026, 11:30 AM UTC.'
    ])
  })

  it('writes a follow-up prompt the agent can act on', async () => {
    mockFeeds()
    const report = reportOf(await runAttentionTool(singleAccount, {}, NOW))
    const workers = report.items.find((item) => item.source === 'workers')

    expect(workers?.followUp).toContain('"checkout"')
    expect(workers?.followUp).toContain('Find the cause')
  })

  it('retries a feed that returns a server error', async () => {
    let calls = 0
    mockFeeds({
      security: () => {
        calls += 1
        return calls === 1
          ? HttpResponse.json(cfError([{ code: 10000, message: 'Internal Server Error' }]), {
              status: 500
            })
          : HttpResponse.json(cfSuccess({ issues: [INSIGHT] }))
      }
    })
    const report = reportOf(await runAttentionTool(singleAccount, {}, NOW))

    expect(calls).toBe(2)
    expect(report.unavailable).toEqual([])
    expect(report.items.some((item) => item.source === 'security')).toBe(true)
  })

  it('reports a failed feed instead of calling the account healthy', async () => {
    mockFeeds({
      workers: () =>
        HttpResponse.json(cfError([{ code: 10000, message: 'Authentication error' }]), {
          status: 403
        })
    })
    const result = await runAttentionTool(singleAccount, {}, NOW)
    const report = reportOf(result)

    expect(report.unavailable).toEqual([
      {
        source: 'workers',
        reason: "This token can't read it. Add the Workers Observability Read permission."
      }
    ])
    expect(result.isError).toBe(false)
    expect(result.content[0]).toMatchObject({
      text: expect.not.stringContaining(`Nothing needs attention in account ${ACCOUNT_ID}.`)
    })
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(
        "Workers issues could not be loaded: This token can't read it. Add the Workers Observability Read permission."
      )
    })
  })

  it('names the missing permission for each feed', async () => {
    const denied = () =>
      HttpResponse.json(cfError([{ code: 10000, message: 'Authentication error' }]), {
        status: 403
      })
    mockFeeds({ alerts: denied, security: denied })
    const report = reportOf(await runAttentionTool(singleAccount, {}, NOW))

    expect(report.unavailable.map(({ source, reason }) => [source, reason])).toEqual([
      ['alerts', "This token can't read it. Add the Notifications Read permission."],
      [
        'security',
        "This token can't read it. Add the Account Security Center Insights Read permission."
      ]
    ])
  })

  it('is an error when no feed loads', async () => {
    const denied = () =>
      HttpResponse.json(cfError([{ code: 10000, message: 'Authentication error' }]), {
        status: 403
      })
    mockFeeds({ alerts: denied, security: denied, workers: denied })

    expect((await runAttentionTool(singleAccount, {}, NOW)).isError).toBe(true)
  })

  it('says nothing needs attention when every feed is empty', async () => {
    mockFeeds({
      alerts: () => HttpResponse.json(cfSuccess([])),
      security: () => HttpResponse.json(cfSuccess({ issues: [] })),
      workers: () => HttpResponse.json(cfSuccess([]))
    })
    const result = await runAttentionTool(singleAccount, {}, NOW)

    expect(reportOf(result).items).toEqual([])
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('Nothing needs attention')
    })
  })

  it('treats an empty alert history as no alerts', async () => {
    mockFeeds({ alerts: () => HttpResponse.json(cfSuccess(null)) })
    const report = reportOf(await runAttentionTool(singleAccount, {}, NOW))

    expect(report.unavailable).toEqual([])
    expect(report.items.some((item) => item.source === 'alerts')).toBe(false)
  })

  it('asks for an account when the connection reaches several', async () => {
    const result = await runAttentionTool(multiAccount, {}, NOW)

    expect(result.isError).toBe(true)
    expect(result).not.toHaveProperty('structuredContent')
  })

  it('rejects an account the connection cannot reach before calling any feed', async () => {
    const result = await runAttentionTool(multiAccount, { account_id: 'f'.repeat(32) }, NOW)

    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(
        `account_id ${'f'.repeat(32)} is not one of this session's accounts`
      )
    })
  })

  it('uses the account the caller picks', async () => {
    server.use(
      http.get(`${API_BASE}/accounts/${OTHER_ACCOUNT_ID}/*`, () => HttpResponse.json(cfSuccess([])))
    )
    const report = reportOf(
      await runAttentionTool(multiAccount, { account_id: OTHER_ACCOUNT_ID }, NOW)
    )

    expect(report.accountId).toBe(OTHER_ACCOUNT_ID)
  })
})

describe('show_attention over MCP', () => {
  beforeEach(async () => {
    await seedSpec({})
  })

  afterEach(async () => {
    await clearKv(env.OAUTH_KV)
    await clearSpec()
  })

  it('returns the report from tools/call', async () => {
    mockIdentityProbe({
      user: { id: 'user-1', email: 'a@example.com' },
      accounts: [{ id: ACCOUNT_ID, name: 'Alice Co' }]
    })
    mockFeeds()
    const response = await exports.default.fetch(
      modernMcpRequest('cfut_attention', 'tools/call', { name: 'show_attention', arguments: {} })
    )
    const body = await parseMcpResult(response)
    const report = AttentionReportSchema.parse(body.result?.structuredContent)

    expect(report.items).toHaveLength(3)
  })
})

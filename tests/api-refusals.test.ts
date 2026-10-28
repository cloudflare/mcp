import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_BASE, cfError, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, callTool, modernMcpRequest, parseMcpResult, toolText } from './helpers/mcp'
import { connectWithOAuth } from './helpers/oauth'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'

/**
 * Cloudflare answers a missing scope, an endpoint OAuth can't reach, and a
 * missing role with the same 403. These tests drive the real worker and check
 * the tool result tells them apart, in both tool modes.
 */

const ZONE_ID = '023e105f4ecef8ad9ca31a8372d0c353'
const ACCOUNT_ID = '00000000000000000000000000000001'
const DNS_PATH = `/zones/${ZONE_ID}/dns_records`
const DOCS_URL = 'https://developers.cloudflare.com/api/resources/dns/subresources/records/'

const AUTHENTICATION_ERROR = cfError([{ code: 10000, message: 'Authentication error' }])

beforeEach(async () => {
  await seedSpec(
    {
      '/zones/{zone_id}/dns_records': {
        get: {
          summary: 'List DNS Records',
          'x-api-token-group': ['DNS Read', 'DNS Write'],
          parameters: [{ name: 'zone_id', in: 'path', required: true }]
        }
      },
      '/accounts/{account_id}/billing/profile': {
        get: {
          summary: 'Billing Profile Details',
          'x-api-token-group': ['Billing Write', 'Billing Read'],
          parameters: [{ name: 'account_id', in: 'path', required: true }]
        }
      }
    },
    ['dns']
  )
})

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

function refuseDnsRecords(): void {
  server.use(
    http.get(`${API_BASE}${DNS_PATH}`, () =>
      HttpResponse.json(
        {
          ...AUTHENTICATION_ERROR,
          errors: [{ code: 10000, message: 'Authentication error', documentation_url: DOCS_URL }]
        },
        { status: 403 }
      )
    )
  )
}

// `scopeChallenge=tool` keeps the tool result when a scope is missing, instead of a 403 challenge.
async function execute(token: string, code: string): Promise<string> {
  const body = await parseMcpResult(
    await exports.default.fetch(
      modernMcpRequest(
        token,
        'tools/call',
        { name: 'execute', arguments: { code } },
        { url: `${MCP_URL}?scopeChallenge=tool` }
      )
    )
  )
  return body.result?.content?.[0]?.text ?? ''
}

const GET_DNS = `async () => cloudflare.request({ method: "GET", path: "${DNS_PATH}" })`

describe('execute explains a refused request', () => {
  it('names the scope an OAuth connection is missing', async () => {
    const token = await connectWithOAuth(['user:read', 'account:read'])
    refuseDnsRecords()

    const text = await execute(token, GET_DNS)

    expect(text).toContain(
      `Cloudflare API error: GET ${DNS_PATH} returned HTTP 403: 10000: Authentication error (${DOCS_URL})`
    )
    expect(text).toContain('was not granted a scope this endpoint accepts')
    expect(text).toContain('`dns.read` (DNS Read)')
  })

  it('says reconnecting will not help when the connection already has the scope', async () => {
    const token = await connectWithOAuth(['user:read', 'account:read', 'dns.read'])
    refuseDnsRecords()

    const text = await execute(token, GET_DNS)

    expect(text).toContain('already has `dns.read` (DNS Read)')
    expect(text).toContain('reconnecting will not help')
  })

  it('points to an API token for an endpoint OAuth cannot reach', async () => {
    const token = await connectWithOAuth(['user:read', 'account:read'], {
      id: ACCOUNT_ID,
      name: 'Acc'
    })
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/billing/profile`, () =>
        HttpResponse.json(AUTHENTICATION_ERROR, { status: 403 })
      )
    )

    const text = await execute(
      token,
      `async () => cloudflare.request({ method: "GET", path: "/accounts/${ACCOUNT_ID}/billing/profile" })`
    )

    expect(text).toContain('No OAuth scope covers this endpoint')
  })

  it('lists the permissions an API token needs', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    refuseDnsRecords()

    const text = toolText(await callTool('cfat_refused', 'execute', { code: GET_DNS }))

    expect(text).toContain('returned HTTP 403')
    expect(text).toContain('needs one of these permissions: DNS Read (`dns.read`)')
  })

  it('keeps the explanation in the error when the code catches it', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    refuseDnsRecords()

    const text = toolText(
      await callTool('cfat_refused', 'execute', {
        code: `async () => { try { await cloudflare.request({ method: "GET", path: "${DNS_PATH}" }) } catch (e) { return e.message } }`
      })
    )

    expect(text).toContain('needs one of these permissions: DNS Read')
  })

  it('omits a missing error code and does not double the period', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    server.use(
      http.get(`${API_BASE}${DNS_PATH}`, () =>
        HttpResponse.json(
          { success: false, errors: [{ message: 'No access to the specified resource.' }] },
          { status: 403 }
        )
      )
    )

    const text = toolText(await callTool('cfat_refused', 'execute', { code: GET_DNS }))

    expect(text).toContain(
      `GET ${DNS_PATH} returned HTTP 403: No access to the specified resource. This endpoint needs`
    )
    expect(text).not.toContain('undefined')
  })

  it('adds nothing to errors other than 401 and 403', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    server.use(
      http.get(`${API_BASE}${DNS_PATH}`, () =>
        HttpResponse.json(cfError([{ code: 7003, message: 'Could not route' }]), {
          status: 404
        })
      )
    )

    const text = toolText(await callTool('cfat_refused', 'execute', { code: GET_DNS }))

    expect(text).toContain(`GET ${DNS_PATH} returned HTTP 404: 7003: Could not route`)
    expect(text).not.toContain('permission')
  })
})

describe('endpoint tools explain a refused request', () => {
  it('names the scope an OAuth connection is missing', async () => {
    const token = await connectWithOAuth(['user:read', 'account:read'])
    refuseDnsRecords()

    const body = await parseMcpResult(
      await exports.default.fetch(
        modernMcpRequest(
          token,
          'tools/call',
          { name: 'get_zones_dns_records', arguments: { zone_id: ZONE_ID } },
          { url: `${MCP_URL}?codemode=false&scopeChallenge=tool` }
        )
      )
    )
    const text = body.result?.content?.[0]?.text ?? ''

    expect(body.result?.isError).toBe(true)
    expect(text).toContain(`Cloudflare API error: GET ${DNS_PATH} returned HTTP 403.`)
    expect(text).toContain('Authentication error')
    expect(text).toContain('`dns.read` (DNS Read)')
  })
})

describe('a 403 about the resource or the account is not a refusal', () => {
  // Cloudflare's answers, from production: Zaraz in realtime mode, and Images on an account without it.
  const NOT_PREVIEW = cfError([{ code: 403, message: 'Forbidden: workflow is not preview' }])
  const NO_IMAGES = cfError([
    {
      code: 5403,
      message: 'The given account is not valid or is not authorized to access this service'
    }
  ])

  function answerDnsRecords(body: object): void {
    server.use(http.get(`${API_BASE}${DNS_PATH}`, () => HttpResponse.json(body, { status: 403 })))
  }

  async function executeResult(token: string, code: string) {
    const body = await parseMcpResult(
      await exports.default.fetch(
        modernMcpRequest(
          token,
          'tools/call',
          { name: 'execute', arguments: { code } },
          { url: `${MCP_URL}?scopeChallenge=tool` }
        )
      )
    )
    return { text: body.result?.content?.[0]?.text ?? '', meta: body.result?._meta }
  }

  it('reports it as Cloudflare sent it, with no step-up, when a scope is missing', async () => {
    const token = await connectWithOAuth(['user:read', 'account:read'])
    answerDnsRecords(NOT_PREVIEW)

    const { text, meta } = await executeResult(token, GET_DNS)

    expect(text).toContain(
      `GET ${DNS_PATH} returned HTTP 403: 403: Forbidden: workflow is not preview`
    )
    expect(text).not.toContain('was not granted')
    expect(meta).not.toHaveProperty('mcp/www_authenticate')
  })

  it('does not blame the role when the connection has the scope', async () => {
    const token = await connectWithOAuth(['user:read', 'account:read', 'dns.read'])
    answerDnsRecords(NO_IMAGES)

    const { text } = await executeResult(token, GET_DNS)

    expect(text).toContain('5403: The given account is not valid')
    expect(text).not.toContain('reconnecting will not help')
  })

  it('still refuses when one of the errors is an authentication error', async () => {
    const token = await connectWithOAuth(['user:read', 'account:read'])
    answerDnsRecords(
      cfError([
        { code: 5403, message: 'Not entitled' },
        { code: 10000, message: 'Authentication error' }
      ])
    )

    const { text, meta } = await executeResult(token, GET_DNS)

    expect(text).toContain('`dns.read` (DNS Read)')
    expect(meta?.['mcp/www_authenticate']).toHaveLength(1)
  })

  it('reports it as Cloudflare sent it from an endpoint tool', async () => {
    const token = await connectWithOAuth(['user:read', 'account:read'])
    answerDnsRecords(NOT_PREVIEW)

    const body = await parseMcpResult(
      await exports.default.fetch(
        modernMcpRequest(
          token,
          'tools/call',
          { name: 'get_zones_dns_records', arguments: { zone_id: ZONE_ID } },
          { url: `${MCP_URL}?codemode=false&scopeChallenge=tool` }
        )
      )
    )
    const text = body.result?.content?.[0]?.text ?? ''

    expect(body.result?.isError).toBe(true)
    expect(text).toContain('Forbidden: workflow is not preview')
    expect(text).not.toContain('`dns.read`')
    expect(body.result?._meta).not.toHaveProperty('mcp/www_authenticate')
  })
})

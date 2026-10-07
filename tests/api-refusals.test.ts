import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_BASE, cfError, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, callTool, modernMcpRequest, parseMcpResult, toolText } from './helpers/mcp'
import { connectWithOAuth } from './helpers/oauth'
import { clearSpec, seedSpec } from './helpers/spec'
import { directTool } from './helpers/direct-tools'
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
    ['dns'],
    [
      directTool({
        name: 'dns_records_list',
        path: '/zones/{zone_id}/dns_records',
        permissions: ['DNS Read', 'DNS Write']
      })
    ]
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
          { name: 'dns_records_list', arguments: { zone_id: ZONE_ID } },
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

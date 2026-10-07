import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_BASE, cfError, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import {
  MCP_URL,
  callTool,
  mcpToolCallRequest,
  mcpToolListRequest,
  modernMcpRequest,
  parseMcpResult,
  toolText
} from './helpers/mcp'
import { connectWithOAuth } from './helpers/oauth'
import { clearSpec, seedSpec } from './helpers/spec'
import { directTool } from './helpers/direct-tools'
import { server } from './setup/msw'

/**
 * Step-up (MCP scope challenge handling): when Cloudflare refuses a request an
 * OAuth connection lacks the scope for, and retrying the call is safe, the
 * response is `403 insufficient_scope` naming the scope, so the client
 * re-authorizes and retries. Driven through the real worker and OAuth flow.
 */

const ZONE_ID = '023e105f4ecef8ad9ca31a8372d0c353'
const DNS_PATH = `/zones/${ZONE_ID}/dns_records`
const RESOURCE_METADATA = 'https://mcp.cloudflare.com/.well-known/oauth-protected-resource/mcp'
const BASELINE = ['user:read', 'account:read']

const GET_DNS = `async () => cloudflare.request({ method: "GET", path: "${DNS_PATH}" })`

beforeEach(async () => {
  await seedSpec(
    {
      '/zones/{zone_id}/dns_records': {
        get: {
          summary: 'List DNS Records',
          'x-api-token-group': ['DNS Read', 'DNS Write'],
          parameters: [{ name: 'zone_id', in: 'path', required: true }]
        },
        post: {
          summary: 'Create DNS Record',
          'x-api-token-group': ['DNS Write'],
          parameters: [{ name: 'zone_id', in: 'path', required: true }]
        }
      },
      '/zones/{zone_id}/settings': {
        get: { summary: 'Zone Settings', 'x-api-token-group': ['Zone Settings Read'] }
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
  server.use(
    http.get(`${API_BASE}${DNS_PATH}`, () =>
      HttpResponse.json(cfError([{ code: 10000, message: 'Authentication error' }]), {
        status: 403
      })
    ),
    http.post(`${API_BASE}${DNS_PATH}`, () => HttpResponse.json(cfSuccess({ id: 'r1' }))),
    http.get(`${API_BASE}/zones/${ZONE_ID}/settings`, () => HttpResponse.json(cfSuccess([])))
  )
})

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

function expectChallenge(response: Response, scope: string): void {
  expect(response.status).toBe(403)
  const challenge = response.headers.get('WWW-Authenticate') ?? ''
  expect(challenge).toContain('error="insufficient_scope"')
  expect(challenge).toContain(`scope="${[...BASELINE, scope].join(' ')}"`)
  expect(challenge).toContain(`resource_metadata="${RESOURCE_METADATA}"`)
}

function executeModern(token: string, code: string, url = MCP_URL): Promise<Response> {
  return exports.default.fetch(
    modernMcpRequest(token, 'tools/call', { name: 'execute', arguments: { code } }, { url })
  )
}

describe('execute', () => {
  it('challenges for the missing scope', async () => {
    const token = await connectWithOAuth(BASELINE)
    expectChallenge(await executeModern(token, GET_DNS), 'dns.read')
  })

  it('challenges a 2025-era request too', async () => {
    const token = await connectWithOAuth(BASELINE)
    const response = await exports.default.fetch(
      mcpToolCallRequest(token, 'execute', { code: GET_DNS })
    )
    expectChallenge(response, 'dns.read')
  })

  it('challenges after earlier reads', async () => {
    const token = await connectWithOAuth(BASELINE)
    const code = `async () => {
      await cloudflare.request({ method: "GET", path: "/zones/${ZONE_ID}/settings" })
      return cloudflare.request({ method: "GET", path: "${DNS_PATH}" })
    }`
    expectChallenge(await executeModern(token, code), 'dns.read')
  })

  it('does not challenge when an earlier write went through, and says why', async () => {
    const token = await connectWithOAuth(BASELINE)
    const code = `async () => {
      await cloudflare.request({ method: "POST", path: "${DNS_PATH}", body: { type: "A" } })
      return cloudflare.request({ method: "GET", path: "${DNS_PATH}" })
    }`
    const response = await executeModern(token, code)
    const body = await parseMcpResult(response)

    expect(response.status).toBe(200)
    expect(body.result?.isError).toBe(true)
    expect(body.result?.content?.[0]?.text).toContain('not offered for an automatic retry')
    expect(body.result?._meta).not.toHaveProperty('mcp/www_authenticate')
  })

  it('does not challenge when the code handles the refusal', async () => {
    const token = await connectWithOAuth(BASELINE)
    const code = `async () => {
      try { await cloudflare.request({ method: "GET", path: "${DNS_PATH}" }) } catch { return "handled" }
    }`
    const response = await executeModern(token, code)

    expect(response.status).toBe(200)
    expect((await parseMcpResult(response)).result?.content?.[0]?.text).toContain('handled')
  })

  it('does not challenge when the connection already has an accepted scope', async () => {
    const token = await connectWithOAuth([...BASELINE, 'dns.write'])
    const response = await executeModern(token, GET_DNS)

    expect(response.status).toBe(200)
    expect((await parseMcpResult(response)).result?.content?.[0]?.text).toContain(
      'reconnecting will not help'
    )
  })

  it('ignores a scope the code reports that is not in the catalog', async () => {
    const token = await connectWithOAuth(BASELINE)
    const code = `async () => { const e = new Error("no"); e.missingScope = "admin"; throw e }`
    const response = await executeModern(token, code)

    expect(response.status).toBe(200)
    expect((await parseMcpResult(response)).result?.isError).toBe(true)
  })

  it('puts the challenge in the tool result with scopeChallenge=tool', async () => {
    const token = await connectWithOAuth(BASELINE)
    const response = await executeModern(token, GET_DNS, `${MCP_URL}?scopeChallenge=tool`)
    const body = await parseMcpResult(response)

    expect(response.status).toBe(200)
    expect(body.result?.isError).toBe(true)
    const [challenge] = body.result?._meta?.['mcp/www_authenticate'] as string[]
    expect(challenge).toContain('error="insufficient_scope"')
    expect(challenge).toContain('scope="user:read account:read dns.read"')
  })

  it('never challenges a direct API token', async () => {
    mockIdentityProbe({ accounts: [{ id: 'acc-1', name: 'Acc' }] })
    const result = await callTool('cfat_direct', 'execute', { code: GET_DNS })

    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toContain('needs one of these permissions')
  })
})

describe('endpoint tools', () => {
  it('challenge for the missing scope', async () => {
    const token = await connectWithOAuth(BASELINE)
    const response = await exports.default.fetch(
      modernMcpRequest(
        token,
        'tools/call',
        { name: 'dns_records_list', arguments: { zone_id: ZONE_ID } },
        { url: `${MCP_URL}?codemode=false` }
      )
    )
    expectChallenge(response, 'dns.read')
  })
})

describe('OAuth connections over 2025-era HTTP', () => {
  it('get JSON responses', async () => {
    const token = await connectWithOAuth(BASELINE)
    const response = await exports.default.fetch(mcpToolListRequest(token))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('application/json')
    expect((await parseMcpResult(response)).result?.tools?.map((tool) => tool.name)).toContain(
      'execute'
    )
  })
})

import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  API_BASE,
  cfAccountsSuccess,
  cfError,
  cfSuccess,
  mockIdentityProbe
} from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import {
  MCP_HOST,
  MCP_URL,
  mcpToolListRequest,
  modernMcpRequest,
  parseMcpResult
} from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'

const API_TOKEN = 'modern-mcp-token'
const ACCOUNT_ID = '00000000000000000000000000000001'

const SPEC_PATHS = {
  '/accounts/{account_id}/workers/scripts': {
    get: {
      summary: 'List Workers',
      tags: ['Workers'],
      parameters: [{ name: 'account_id', in: 'path', required: true }],
      responses: {}
    }
  }
}

beforeEach(async () => {
  await seedSpec(SPEC_PATHS)
  mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Modern MCP' }] })
})

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

describe('MCP 2026-07-28 stateless handler', () => {
  it('serves server/discover without creating a protocol session', async () => {
    const response = await exports.default.fetch(modernMcpRequest(API_TOKEN, 'server/discover'))
    const body = await parseMcpResult(response)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('mcp-session-id')).toBeNull()
    expect(body).toMatchObject({
      result: {
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        serverInfo: { name: 'cloudflare-api', version: '0.1.0' }
      }
    })
  })

  it('serves modern tools/list with a complete result', async () => {
    const response = await exports.default.fetch(modernMcpRequest(API_TOKEN, 'tools/list'))
    const body = await parseMcpResult(response)

    expect(response.status).toBe(200)
    expect(body.result?.resultType).toBe('complete')
    expect(body.result?.tools?.map((tool) => tool.name)).toEqual(['docs', 'search', 'execute'])
  })

  it('serves a modern Code Mode tools/call', async () => {
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/tokens/verify`, () =>
        HttpResponse.json(cfSuccess({ id: 'token-1', status: 'active' }))
      )
    )
    const code = `async () => cloudflare.request({ method: "GET", path: "/accounts/${ACCOUNT_ID}/tokens/verify" })`

    const response = await exports.default.fetch(
      modernMcpRequest(API_TOKEN, 'tools/call', {
        name: 'execute',
        arguments: { code }
      })
    )
    const body = await parseMcpResult(response)

    expect(response.status).toBe(200)
    expect(body.result?.resultType).toBe('complete')
    expect(body.result?.isError).toBeFalsy()
    expect(body.result?.content?.[0]?.text).toContain('"status": "active"')
  })

  it('serves a modern non-Code-Mode tools/call', async () => {
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/workers/scripts`, () =>
        HttpResponse.json(cfSuccess([{ id: 'worker-a' }]))
      )
    )

    const response = await exports.default.fetch(
      modernMcpRequest(
        API_TOKEN,
        'tools/call',
        {
          name: 'get_accounts_workers_scripts',
          arguments: {}
        },
        { url: `${MCP_URL}?codemode=false` }
      )
    )
    const body = await parseMcpResult(response)

    expect(response.status).toBe(200)
    expect(body.result?.resultType).toBe('complete')
    expect(body.result?.isError).toBeFalsy()
    expect(body.result?.content?.[0]?.text).toContain('worker-a')
  })

  it('isolates authenticated props across concurrent requests', async () => {
    const firstAccount = '00000000000000000000000000000002'
    const secondAccount = '00000000000000000000000000000003'
    server.use(
      http.get(`${API_BASE}/user`, () => HttpResponse.json(cfError([], null))),
      http.get(`${API_BASE}/accounts`, ({ request }) => {
        const account =
          request.headers.get('Authorization') === 'Bearer token-a'
            ? { id: firstAccount, name: 'First' }
            : { id: secondAccount, name: 'Second' }
        return HttpResponse.json(cfAccountsSuccess([account]))
      }),
      http.get(`${API_BASE}/accounts/${firstAccount}/workers/scripts`, () =>
        HttpResponse.json(cfSuccess([{ id: 'first-worker' }]))
      ),
      http.get(`${API_BASE}/accounts/${secondAccount}/workers/scripts`, () =>
        HttpResponse.json(cfSuccess([{ id: 'second-worker' }]))
      )
    )
    const request = (token: string, id: number) =>
      modernMcpRequest(
        token,
        'tools/call',
        { name: 'get_accounts_workers_scripts', arguments: {} },
        { id, url: `${MCP_URL}?codemode=false` }
      )

    const [firstResponse, secondResponse] = await Promise.all([
      exports.default.fetch(request('token-a', 1)),
      exports.default.fetch(request('token-b', 2))
    ])
    const [first, second] = await Promise.all([
      parseMcpResult(firstResponse),
      parseMcpResult(secondResponse)
    ])

    expect(first.result?.content?.[0]?.text).toContain('first-worker')
    expect(first.result?.content?.[0]?.text).not.toContain('second-worker')
    expect(second.result?.content?.[0]?.text).toContain('second-worker')
    expect(second.result?.content?.[0]?.text).not.toContain('first-worker')
  })

  it('isolates concurrent factories with different requested tool surfaces', async () => {
    const [codemodeResponse, endpointResponse] = await Promise.all([
      exports.default.fetch(modernMcpRequest(API_TOKEN, 'tools/list', {}, { id: 1 })),
      exports.default.fetch(
        modernMcpRequest(
          API_TOKEN,
          'tools/list',
          {},
          {
            id: 2,
            url: `${MCP_URL}?codemode=false`
          }
        )
      )
    ])
    const [codemode, endpoints] = await Promise.all([
      parseMcpResult(codemodeResponse),
      parseMcpResult(endpointResponse)
    ])

    expect(codemodeResponse.status).toBe(200)
    expect(endpointResponse.status).toBe(200)
    expect(codemode.result?.tools?.map((tool) => tool.name)).toEqual(['docs', 'search', 'execute'])
    expect(endpoints.result?.tools?.map((tool) => tool.name)).toEqual([
      'docs',
      'get_accounts_workers_scripts'
    ])
    expect(codemodeResponse.headers.get('mcp-session-id')).toBeNull()
    expect(endpointResponse.headers.get('mcp-session-id')).toBeNull()
  })

  it('rejects a mismatched modern method header', async () => {
    const response = await exports.default.fetch(
      modernMcpRequest(
        API_TOKEN,
        'tools/list',
        {},
        {
          headers: { 'Mcp-Method': 'tools/call' }
        }
      )
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('Mcp-Method') },
      id: 1,
      jsonrpc: '2.0'
    })
  })

  it('retains stateless 2025 compatibility by default', async () => {
    const response = await exports.default.fetch(mcpToolListRequest(API_TOKEN))
    const body = await parseMcpResult(response)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('mcp-session-id')).toBeNull()
    expect(body.result?.tools?.map((tool) => tool.name)).toEqual(['docs', 'search', 'execute'])
  })

  it.each(['GET', 'DELETE'])('rejects session-only %s requests', async (method) => {
    const response = await exports.default.fetch(
      new Request(MCP_URL, {
        method,
        headers: {
          Host: MCP_HOST,
          Authorization: `Bearer ${API_TOKEN}`,
          Accept: 'application/json, text/event-stream'
        }
      })
    )

    expect(response.status).toBe(405)
    expect(await response.json()).toMatchObject({
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
      jsonrpc: '2.0'
    })
  })

  it('keeps session-only methods behind bearer authentication', async () => {
    const response = await exports.default.fetch(
      new Request(MCP_URL, {
        method: 'GET',
        headers: { Host: MCP_HOST, Accept: 'application/json, text/event-stream' }
      })
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: 'invalid_token' })
  })
})

describe('MCP deployment boundary', () => {
  it('does not treat longer path prefixes as the MCP endpoint', async () => {
    const response = await exports.default.fetch(
      modernMcpRequest(API_TOKEN, 'server/discover', {}, { url: `${MCP_URL}/other` })
    )

    expect(response.status).toBe(404)
  })

  it('allows the production Host and same-host browser Origin', async () => {
    const response = await exports.default.fetch(
      modernMcpRequest(API_TOKEN, 'server/discover', {}, { origin: `https://${MCP_HOST}` })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe(`https://${MCP_HOST}`)
    expect(response.headers.get('vary')).toContain('Origin')
  })

  it('rejects an unlisted browser Origin before probing the bearer token', async () => {
    let identityProbeCalls = 0
    server.use(
      http.get(`${API_BASE}/user`, () => {
        identityProbeCalls++
        return HttpResponse.json(cfSuccess(null))
      }),
      http.get(`${API_BASE}/accounts`, () => {
        identityProbeCalls++
        return HttpResponse.json(cfSuccess([]))
      })
    )

    const response = await exports.default.fetch(
      modernMcpRequest(
        API_TOKEN,
        'server/discover',
        {},
        {
          origin: 'https://attacker.example'
        }
      )
    )

    expect(response.status).toBe(403)
    expect(identityProbeCalls).toBe(0)
  })

  it('does not derive trust from an attacker-controlled matching Host and Origin', async () => {
    const response = await exports.default.fetch(
      modernMcpRequest(
        API_TOKEN,
        'server/discover',
        {},
        {
          url: 'https://attacker.example/mcp',
          host: 'attacker.example',
          origin: 'https://attacker.example'
        }
      )
    )

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('Invalid Host') }
    })
  })

  it('serves modern CORS preflight headers without authentication', async () => {
    const response = await exports.default.fetch(
      new Request(MCP_URL, {
        method: 'OPTIONS',
        headers: {
          Host: MCP_HOST,
          Origin: `https://${MCP_HOST}`,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers':
            'authorization, content-type, mcp-method, mcp-name, mcp-param-account-id'
        }
      })
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(`https://${MCP_HOST}`)
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'authorization, content-type, mcp-method, mcp-name, mcp-param-account-id'
    )
  })
})

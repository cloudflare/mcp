import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mockIdentityProbe } from '../helpers/cloudflare-api'
import { clearKv } from '../helpers/kv'
import { MCP_HOST, MCP_URL, mcpToolListRequest, parseMcpResult } from '../helpers/mcp'
import { clearSpec, seedSpec } from '../helpers/spec'

const API_TOKEN = 'legacy-mcp-token'
const ACCOUNT_ID = '00000000000000000000000000000001'
const LEGACY_VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25'] as const

function initializeRequest(protocolVersion: string): Request {
  return new Request(MCP_URL, {
    method: 'POST',
    headers: {
      Host: MCP_HOST,
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: 'cloudflare-mcp-legacy-tests', version: '1.0.0' }
      }
    })
  })
}

beforeEach(async () => {
  await seedSpec({})
  mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Legacy MCP' }] })
})

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

describe('legacy Streamable HTTP initialize', () => {
  it.each(LEGACY_VERSIONS)('negotiates %s without creating a session', async (version) => {
    const response = await exports.default.fetch(initializeRequest(version))
    const body = await parseMcpResult(response)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('mcp-session-id')).toBeNull()
    expect(body).toMatchObject({
      result: {
        protocolVersion: version,
        serverInfo: { name: 'cloudflare-api', version: '0.1.0' }
      }
    })
    expect(body.result).not.toHaveProperty('resultType')
  })
})

describe('legacy Streamable HTTP tools', () => {
  it.each(LEGACY_VERSIONS)('lists tools using %s', async (version) => {
    const request = mcpToolListRequest(API_TOKEN)
    request.headers.set('MCP-Protocol-Version', version)

    const response = await exports.default.fetch(request)
    const body = await parseMcpResult(response)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('mcp-session-id')).toBeNull()
    expect(body.result?.tools?.map((tool) => tool.name)).toEqual(['docs', 'search', 'execute'])
    expect(body.result).not.toHaveProperty('resultType')
  })

  it('keeps the specified 2025-03-26 fallback for clients that omit the header', async () => {
    const response = await exports.default.fetch(mcpToolListRequest(API_TOKEN))
    const body = await parseMcpResult(response)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(body.result?.tools?.map((tool) => tool.name)).toEqual(['docs', 'search', 'execute'])
  })
})

describe('legacy Streamable HTTP session methods', () => {
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

import { env, exports } from 'cloudflare:workers'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_HOST, MCP_URL, MODERN_MCP_VERSION } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'

const API_TOKEN = 'modern-client-token'
const ACCOUNT_ID = '00000000000000000000000000000001'
const SPEC_PATH = '/accounts/{account_id}/workers/scripts'

beforeEach(async () => {
  await seedSpec({
    [SPEC_PATH]: {
      get: {
        summary: 'List Workers',
        tags: ['Workers'],
        parameters: [{ name: 'account_id', in: 'path', required: true }],
        responses: {}
      }
    }
  })
  mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Modern Client' }] })
})

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

describe('automatic protocol negotiation', () => {
  it('selects modern MCP, then lists and calls tools without a session', async () => {
    const requests: Array<{ method: string; rpcMethod?: string }> = []
    const workerFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const body =
        request.method === 'POST'
          ? ((await request.clone().json()) as { method?: string })
          : undefined
      const headers = new Headers(request.headers)
      headers.set('Host', MCP_HOST)
      headers.set('Authorization', `Bearer ${API_TOKEN}`)
      const authenticated = new Request(request, { headers })
      const response = await exports.default.fetch(authenticated)
      requests.push({ method: request.method, rpcMethod: body?.method })
      return response
    }

    const client = new Client(
      { name: 'cloudflare-mcp-modern-client-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } }
    )
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: workerFetch
    })

    try {
      await client.connect(transport)

      expect(client.getProtocolEra()).toBe('modern')
      expect(client.getNegotiatedProtocolVersion()).toBe(MODERN_MCP_VERSION)
      expect(client.getServerVersion()).toEqual({ name: 'cloudflare-api', version: '0.1.0' })
      expect(client.getDiscoverResult()?.supportedVersions).toEqual([MODERN_MCP_VERSION])

      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual(['docs', 'search', 'execute'])

      const called = await client.callTool({
        name: 'search',
        arguments: { code: 'async () => Object.keys(spec.paths)' }
      })
      expect(called.isError).toBeFalsy()
      expect(called.content[0]).toMatchObject({ type: 'text' })
      expect(called.content[0]?.type === 'text' ? called.content[0].text : '').toContain(SPEC_PATH)

      expect(requests).toEqual([
        { method: 'POST', rpcMethod: 'server/discover' },
        { method: 'POST', rpcMethod: 'tools/list' },
        { method: 'POST', rpcMethod: 'tools/call' }
      ])
    } finally {
      await client.close()
    }
  })
})

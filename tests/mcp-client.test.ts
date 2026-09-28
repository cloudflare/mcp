import { env, exports } from 'cloudflare:workers'
import {
  Client,
  InMemoryResponseCacheStore,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_HOST, MCP_URL, MODERN_MCP_VERSION } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'

const API_TOKEN = 'modern-client-token'
const ACCOUNT_ID = '00000000000000000000000000000001'
const SPEC_PATH = '/accounts/{account_id}/workers/scripts'

type RecordedRequest = { method: string; rpcMethod?: string }

/** A client `fetch` that sends each request to the worker as `token` and records it. */
function workerFetchAs(token: string, requests: RecordedRequest[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const body =
      request.method === 'POST'
        ? ((await request.clone().json()) as { method?: string })
        : undefined
    const headers = new Headers(request.headers)
    headers.set('Host', MCP_HOST)
    headers.set('Authorization', `Bearer ${token}`)
    const response = await exports.default.fetch(new Request(request, { headers }))
    requests.push({ method: request.method, rpcMethod: body?.method })
    return response
  }
}

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
    const requests: RecordedRequest[] = []
    const client = new Client(
      { name: 'cloudflare-mcp-modern-client-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } }
    )
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: workerFetchAs(API_TOKEN, requests)
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

describe('tool list caching', () => {
  it('shares one tool list across users without mixing the two tool surfaces', async () => {
    // One response cache backing several principals, as a gateway would run it.
    const store = new InMemoryResponseCacheStore()
    const clients: Client[] = []

    async function connect(user: string, url: string, requests: RecordedRequest[]) {
      const client = new Client(
        { name: 'cloudflare-mcp-cache-test', version: '1.0.0' },
        { versionNegotiation: { mode: 'auto' }, responseCacheStore: store, cachePartition: user }
      )
      clients.push(client)
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          fetch: workerFetchAs(`${user}-token`, requests)
        })
      )
      return client
    }

    const aliceRequests: RecordedRequest[] = []
    const bobRequests: RecordedRequest[] = []
    const endpointRequests: RecordedRequest[] = []

    try {
      const alice = await connect('alice', MCP_URL, aliceRequests)
      const bob = await connect('bob', MCP_URL, bobRequests)
      const endpoints = await connect('bob', `${MCP_URL}?codemode=false`, endpointRequests)

      const codeModeTools = ['docs', 'search', 'execute']
      expect((await alice.listTools()).tools.map((tool) => tool.name)).toEqual(codeModeTools)
      expect((await bob.listTools()).tools.map((tool) => tool.name)).toEqual(codeModeTools)
      expect((await endpoints.listTools()).tools.map((tool) => tool.name)).toEqual([
        'docs',
        'get_accounts_workers_scripts'
      ])

      // Bob reused Alice's list. The endpoint tools are a different server, so
      // that client fetched its own.
      expect(aliceRequests.map((request) => request.rpcMethod)).toEqual([
        'server/discover',
        'tools/list'
      ])
      expect(bobRequests.map((request) => request.rpcMethod)).toEqual(['server/discover'])
      expect(endpointRequests.map((request) => request.rpcMethod)).toEqual([
        'server/discover',
        'tools/list'
      ])
      expect(endpoints.getServerVersion()).toEqual({
        name: 'cloudflare-api-endpoints',
        version: '0.1.0'
      })
    } finally {
      await Promise.all(clients.map((client) => client.close()))
    }
  })
})

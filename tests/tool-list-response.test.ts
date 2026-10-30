import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { clearSpec, seedSpec } from './helpers/spec'
import { MCP_HOST, MCP_URL, parseMcpResult } from './helpers/mcp'

/**
 * The direct-tool `tools/list` fast path (src/tools/tool-list-response.ts)
 * must answer exactly what the SDK would. A cursor sends the same request to
 * the SDK, whose handlers ignore it and list every tool, so the two answers can
 * be compared.
 */

const ACCOUNT_ID = '00000000000000000000000000000001'
const TOKEN = 'acct-token-tool-list'

const SPEC_PATHS = {
  '/accounts/{account_id}/workers/scripts': {
    get: {
      summary: 'List Workers',
      tags: ['Workers'],
      parameters: [{ name: 'account_id', in: 'path', required: true }],
      responses: {}
    }
  },
  '/zones/{zone_id}/dns_records': {
    get: {
      summary: 'List DNS Records',
      tags: ['DNS Records for a Zone'],
      parameters: [
        { name: 'zone_id', in: 'path', required: true },
        { name: 'name', in: 'query', schema: { type: 'string' } }
      ],
      responses: {}
    }
  }
}

function listRequest(
  query: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Request {
  return new Request(`${MCP_URL}${query}`, {
    method: 'POST',
    headers: {
      Host: MCP_HOST,
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', ...body })
  })
}

async function listTools(query: string, body: Record<string, unknown>) {
  const response = await exports.default.fetch(listRequest(query, body))
  return { response, message: (await parseMcpResult(response)) as Record<string, unknown> }
}

beforeEach(async () => {
  await seedSpec(SPEC_PATHS)
  mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
})

afterEach(async () => {
  await clearSpec()
  await clearKv(env.OAUTH_KV)
})

describe('direct tools/list fast path', () => {
  for (const [mode, query] of [
    ['mcp-tools.json', '?codemode=false'],
    ['forge', '?codemode=false&experimentalForge=true']
  ] as const) {
    it(`lists the same tools as the SDK (${mode})`, async () => {
      const fast = await listTools(query, { id: 7 })
      const sdk = await listTools(query, { id: 7, params: { cursor: 'all' } })

      expect(fast.response.status).toBe(200)
      expect(fast.response.headers.get('Content-Type')).toBe('application/json')
      expect(fast.message).toEqual(sdk.message)
      const tools = (fast.message.result as { tools: Array<{ name: string }> }).tools
      expect(tools.slice(0, 2).map((tool) => tool.name)).toEqual(['docs', 'whoami'])
      expect(tools.length).toBeGreaterThan(2)
    })
  }

  it('echoes a string id and serves repeat requests from the cached listing', async () => {
    const first = await listTools('?codemode=false', { id: 'a"b' })
    const second = await listTools('?codemode=false', { id: 'a"b', params: { _meta: {} } })

    expect(first.message.id).toBe('a"b')
    expect(second.message).toEqual(first.message)
  })

  it('leaves an unsupported protocol version to the SDK', async () => {
    const response = await exports.default.fetch(
      listRequest('?codemode=false', { id: 1 }, { 'MCP-Protocol-Version': '1999-01-01' })
    )

    expect(response.status).toBe(400)
  })

  it('leaves an SSE-only Accept to the SDK, which refuses it as before', async () => {
    // Streamable HTTP requires a POST to accept both; the SDK answers 406 otherwise.
    const response = await exports.default.fetch(
      listRequest('?codemode=false', { id: 1 }, { Accept: 'text/event-stream' })
    )

    expect(response.status).toBe(406)
    expect(await response.text()).toContain(
      'must accept both application/json and text/event-stream'
    )
  })

  it('leaves Code Mode to the SDK', async () => {
    const { message } = await listTools('', { id: 1 })
    const names = (message.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)

    expect(names).toEqual(expect.arrayContaining(['search', 'execute']))
  })
})

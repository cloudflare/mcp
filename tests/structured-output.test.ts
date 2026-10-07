import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_BASE, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { directTool } from './helpers/direct-tools'
import { clearKv } from './helpers/kv'
import {
  MCP_URL,
  mcpToolCallRequest,
  mcpToolListRequest,
  modernMcpRequest,
  parseMcpResult
} from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'

/**
 * Structured output for direct tools is a 2026-07-28 feature. These drive the
 * real worker in both protocol eras: modern clients get outputSchema and
 * structuredContent, 2025-era clients get exactly the old text-only results.
 */

const ACCOUNT_ID = '00000000000000000000000000000001'
const TOKEN = 'structured-output-token'
const DIRECT_URL = `${MCP_URL}?codemode=false`

const NAMESPACE = {
  type: 'object',
  properties: { id: { type: 'string' }, title: { type: 'string' } },
  required: ['id', 'title']
}
const TOOLS = [
  // Forge documents the unwrapped result for most operations.
  directTool({
    name: 'kv_namespaces_get',
    path: '/accounts/{account_id}/storage/kv/namespaces/{namespace_id}',
    outputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...NAMESPACE },
    unwrapResult: true
  }),
  // Lists with result_info are documented with the envelope.
  directTool({
    name: 'kv_namespaces_list',
    path: '/accounts/{account_id}/storage/kv/namespaces',
    outputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { result: { type: 'array', items: NAMESPACE }, result_info: { type: 'object' } },
      required: ['result']
    }
  }),
  directTool({
    name: 'kv_keys_get',
    path: '/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/{key_name}'
  })
]

const NS = { id: 'ns-1', title: 'first' }
const MANY = Array.from({ length: 400 }, (_, i) => ({
  id: `ns-${i}`,
  title: `namespace ${i} ${'x'.repeat(80)}`
}))

beforeEach(async () => {
  await seedSpec({}, ['workers'], TOOLS)
  mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
  server.use(
    http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/storage/kv/namespaces/ns-1`, () =>
      HttpResponse.json(cfSuccess(NS))
    ),
    http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/storage/kv/namespaces`, () =>
      HttpResponse.json({ ...cfSuccess(MANY), result_info: { page: 1, per_page: 400, count: 400 } })
    ),
    http.get(
      `${API_BASE}/accounts/${ACCOUNT_ID}/storage/kv/namespaces/ns-1/values/hello`,
      () => new HttpResponse('world')
    )
  )
})

afterEach(async () => {
  await clearSpec()
  await clearKv(env.OAUTH_KV)
})

async function modern(method: string, params: Record<string, unknown> = {}) {
  return parseMcpResult(
    await exports.default.fetch(modernMcpRequest(TOKEN, method, params, { url: DIRECT_URL }))
  )
}

async function legacy(request: Request) {
  return parseMcpResult(await exports.default.fetch(new Request(DIRECT_URL, request)))
}

describe('direct tools for MCP 2026-07-28 clients', () => {
  it('lists each generated outputSchema, and none for a tool without one', async () => {
    const body = await modern('tools/list')
    const tools = body.result?.tools as Array<{ name: string; outputSchema?: unknown }>
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))

    expect(byName['kv_namespaces_get']?.outputSchema).toEqual(TOOLS[0]!.outputSchema)
    expect(byName['kv_namespaces_list']?.outputSchema).toEqual(TOOLS[1]!.outputSchema)
    expect(byName['kv_keys_get']?.outputSchema).toBeUndefined()
  })

  it('returns the result as structuredContent when the schema describes the result', async () => {
    const body = await modern('tools/call', {
      name: 'kv_namespaces_get',
      arguments: { namespace_id: 'ns-1' }
    })

    expect(body.result?.structuredContent).toEqual(NS)
    expect(JSON.parse(body.result?.content?.[0]?.text ?? '')).toEqual(cfSuccess(NS))
  })

  it('returns the whole response when the schema describes the envelope, and truncates only the text', async () => {
    const body = await modern('tools/call', { name: 'kv_namespaces_list', arguments: {} })
    const structured = body.result?.structuredContent as { result: unknown[] }

    expect(structured.result).toHaveLength(400)
    expect(body.result?.content?.[0]?.text?.length).toBeLessThanOrEqual(24_000)
    expect(body.result?.content?.[0]?.text).toContain('--- TRUNCATED ---')
  })

  it('keeps non-JSON responses as text only', async () => {
    const body = await modern('tools/call', {
      name: 'kv_keys_get',
      arguments: { namespace_id: 'ns-1', key_name: 'hello' }
    })

    expect(body.result?.structuredContent).toBeUndefined()
    expect(body.result?.content?.[0]?.text).toBe('world')
  })

  it('keeps API errors as text-only tool errors', async () => {
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/storage/kv/namespaces/ns-1`, () =>
        HttpResponse.json(
          {
            success: false,
            errors: [{ code: 10013, message: 'not found' }],
            messages: [],
            result: null
          },
          { status: 404 }
        )
      )
    )
    const body = await modern('tools/call', {
      name: 'kv_namespaces_get',
      arguments: { namespace_id: 'ns-1' }
    })

    expect(body.result?.isError).toBe(true)
    expect(body.result?.structuredContent).toBeUndefined()
  })
})

describe('direct tools for 2025-era clients', () => {
  it('lists no outputSchema', async () => {
    const body = await legacy(mcpToolListRequest(TOKEN))
    const tools = body.result?.tools as Array<{ name: string; outputSchema?: unknown }>

    expect(tools.find((tool) => tool.name === 'kv_namespaces_get')).not.toHaveProperty(
      'outputSchema'
    )
    expect(tools.find((tool) => tool.name === 'kv_namespaces_list')).not.toHaveProperty(
      'outputSchema'
    )
  })

  it('returns text only, exactly as before', async () => {
    const body = await legacy(
      mcpToolCallRequest(TOKEN, 'kv_namespaces_get', { namespace_id: 'ns-1' })
    )

    expect(body.result?.structuredContent).toBeUndefined()
    expect(JSON.parse(body.result?.content?.[0]?.text ?? '')).toEqual(cfSuccess(NS))
  })
})

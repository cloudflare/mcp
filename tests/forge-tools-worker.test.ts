import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tools as generatedTools } from '../src/generated/forge-mcp'
import { API_BASE, cfError, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { clearSpec, seedSpec } from './helpers/spec'
import {
  MCP_URL,
  mcpToolCallRequest,
  mcpToolListRequest,
  parseMcpResult,
  toolText
} from './helpers/mcp'
import { server } from './setup/msw'

/**
 * The generated direct tools at /mcp?forge=true, through the real worker:
 * auth, the transport, the generated tools and their request code, and
 * account resolution are real; the Cloudflare API is mocked with MSW.
 */

const ACCOUNT_ID = '00000000000000000000000000000001'
const ACCOUNT_TOKEN = 'acct-token-forge'
const ZONE_ID = '0000000000000000000000000000000z'

type ListedTool = {
  name: string
  inputSchema: { properties?: Record<string, unknown>; required?: string[] }
  [key: string]: unknown
}

async function listForgeTools(token: string): Promise<ListedTool[]> {
  const req = new Request(`${MCP_URL}?forge=true`, mcpToolListRequest(token))
  const result = (await parseMcpResult(await exports.default.fetch(req))) as unknown as {
    result?: { tools?: ListedTool[] }
  }
  return result.result?.tools ?? []
}

async function callForgeTool(token: string, name: string, args: Record<string, unknown>) {
  const req = new Request(`${MCP_URL}?forge=true`, mcpToolCallRequest(token, name, args))
  return parseMcpResult(await exports.default.fetch(req))
}

beforeEach(async () => {
  await seedSpec({})
  mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
})

afterEach(async () => {
  await clearSpec()
  await clearKv(env.OAUTH_KV)
})

describe('generated direct tools (?forge=true)', () => {
  it('lists docs, whoami and every generated tool, without their request code', async () => {
    const tools = await listForgeTools(ACCOUNT_TOKEN)

    expect(tools.map((tool) => tool.name)).toEqual([
      'docs',
      'whoami',
      ...generatedTools.map((tool) => tool.name)
    ])
    const d1 = tools.find((tool) => tool.name === 'd1_list')!
    expect(d1.inputSchema.required ?? []).not.toContain('account_id')
    for (const key of ['request', 'method', 'path', 'extensions']) {
      expect(d1).not.toHaveProperty(key)
    }
  })

  it('gets the tool list from the service as one JSON string', async () => {
    const json = await env.FORGE_TOOLS.listJson()

    expect(typeof json).toBe('string')
    expect(JSON.parse(json)).toEqual(await env.FORGE_TOOLS.list())
  })

  it("fills in the session's account and sends the token", async () => {
    let called: URL | undefined
    let auth: string | null = null
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/d1/database`, ({ request }) => {
        called = new URL(request.url)
        auth = request.headers.get('Authorization')
        return HttpResponse.json(cfSuccess([{ uuid: 'db-1' }]))
      })
    )

    const result = await callForgeTool(ACCOUNT_TOKEN, 'd1_list', { name: 'prod', per_page: 5 })

    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).toContain('db-1')
    expect(called?.searchParams.get('name')).toBe('prod')
    expect(called?.searchParams.get('per_page')).toBe('5')
    expect(auth).toBe(`Bearer ${ACCOUNT_TOKEN}`)
  })

  it('sends the body argument as JSON', async () => {
    let body: unknown
    server.use(
      http.post(`${API_BASE}/accounts/${ACCOUNT_ID}/d1/database`, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json(cfSuccess({ uuid: 'db-2' }))
      })
    )

    const result = await callForgeTool(ACCOUNT_TOKEN, 'd1_create', {
      body: { name: 'prod', primary_location_hint: 'weur' }
    })

    expect(result.result?.isError).toBeFalsy()
    expect(body).toEqual({ name: 'prod', primary_location_hint: 'weur' })
  })

  it('fills in the account for a merged path called with accounts, and needs the ID for zones', async () => {
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/access/apps`, () =>
        HttpResponse.json(cfSuccess([{ id: 'app-1' }]))
      ),
      http.get(`${API_BASE}/zones/${ZONE_ID}/access/apps`, () =>
        HttpResponse.json(cfSuccess([{ id: 'zone-app' }]))
      )
    )
    const call = (args: Record<string, unknown>) =>
      callForgeTool(ACCOUNT_TOKEN, 'zero_trust_access_applications_list', args)

    const accounts = await call({ account_or_zone: 'accounts' })
    const zoneWithoutId = await call({ account_or_zone: 'zones' })
    const zone = await call({ account_or_zone: 'zones', account_or_zone_id: ZONE_ID })

    expect(toolText(accounts)).toContain('app-1')
    expect(zoneWithoutId.result?.isError).toBe(true)
    expect(toolText(zoneWithoutId)).toBe('Missing path parameter: account_or_zone_id')
    expect(toolText(zone)).toContain('zone-app')
  })

  it("explains a refused call and names the token's account", async () => {
    server.use(
      http.get(`${API_BASE}/accounts/not-mine/d1/database`, () =>
        HttpResponse.json(cfError([{ code: 9109, message: 'Unauthorized' }]), { status: 403 })
      )
    )

    const result = await callForgeTool(ACCOUNT_TOKEN, 'd1_list', { account_id: 'not-mine' })

    expect(result.result?.isError).toBe(true)
    const text = toolText(result)
    expect(text).toContain(
      'Cloudflare API error: GET /accounts/not-mine/d1/database returned HTTP 403.'
    )
    expect(text).toContain("account_id not-mine is not this token's account.")
  })

  it('parses +json responses', async () => {
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/d1/database`, () =>
        HttpResponse.text(JSON.stringify({ Resources: [{ id: 'u1' }] }), {
          headers: { 'Content-Type': 'application/scim+json; charset=utf-8' }
        })
      )
    )

    const result = await callForgeTool(ACCOUNT_TOKEN, 'd1_list', {})

    expect(result.result?.isError).toBeFalsy()
    expect(JSON.parse(toolText(result))).toEqual({ Resources: [{ id: 'u1' }] })
  })

  it('reports an unknown tool', async () => {
    const result = await callForgeTool(ACCOUNT_TOKEN, 'nope', {})

    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toBe('Tool nope not found')
  })

  it('leaves the other tool surfaces alone without ?forge=true', async () => {
    const req = new Request(`${MCP_URL}?codemode=false`, mcpToolListRequest(ACCOUNT_TOKEN))
    const result = (await parseMcpResult(await exports.default.fetch(req))) as unknown as {
      result?: { tools?: Array<{ name: string }> }
    }

    expect(result.result?.tools?.map((tool) => tool.name)).not.toContain('d1_list')
  })
})

import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_BASE, cfError, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { clearSpec, seedSpec } from './helpers/spec'
import { genericTool, seedForgeTools } from './helpers/forge-tools'
import {
  MCP_URL,
  mcpToolCallRequest,
  mcpToolListRequest,
  parseMcpResult,
  toolText
} from './helpers/mcp'
import { server } from './setup/msw'

/**
 * The forge-mcp direct tools at /mcp?forge=true, through the real worker:
 * auth, the transport, catalogue loading, account resolution and request
 * building are real; the Cloudflare API is mocked with MSW.
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
  await seedForgeTools([
    {
      tool: genericTool('workers_scripts_list', 'GET', '/accounts/{account_id}/workers/scripts', {
        query: ['tags']
      }),
      permissions: ['Workers Scripts Read']
    },
    {
      tool: genericTool('d1_database_create', 'POST', '/accounts/{account_id}/d1/database', {
        body: true
      })
    },
    {
      tool: genericTool(
        'access_apps_list',
        'GET',
        '/{account_or_zone}/{account_or_zone_id}/access/apps'
      )
    }
  ])
  mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
})

afterEach(async () => {
  await clearSpec()
  await clearKv(env.OAUTH_KV)
})

describe('forge-mcp direct tools (?forge=true)', () => {
  it('lists docs, whoami and the catalogue tools, without routes or extensions', async () => {
    const tools = await listForgeTools(ACCOUNT_TOKEN)

    expect(tools.map((tool) => tool.name)).toEqual([
      'docs',
      'whoami',
      'workers_scripts_list',
      'd1_database_create',
      'access_apps_list'
    ])
    const workers = tools.find((tool) => tool.name === 'workers_scripts_list')!
    expect(workers.inputSchema.required ?? []).not.toContain('account_id')
    expect(workers).not.toHaveProperty('request')
    expect(workers).not.toHaveProperty('extensions')
  })

  it("fills in the session's account and forwards query arguments", async () => {
    let called: URL | undefined
    let auth: string | null = null
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/workers/scripts`, ({ request }) => {
        called = new URL(request.url)
        auth = request.headers.get('Authorization')
        return HttpResponse.json(cfSuccess([{ id: 'worker-a' }]))
      })
    )

    const result = await callForgeTool(ACCOUNT_TOKEN, 'workers_scripts_list', { tags: 'prod' })

    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).toContain('worker-a')
    expect(called?.searchParams.get('tags')).toBe('prod')
    expect(auth).toBe(`Bearer ${ACCOUNT_TOKEN}`)
  })

  it('sends the body argument as JSON', async () => {
    let body: unknown
    server.use(
      http.post(`${API_BASE}/accounts/${ACCOUNT_ID}/d1/database`, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json(cfSuccess({ uuid: 'db-1' }))
      })
    )

    const result = await callForgeTool(ACCOUNT_TOKEN, 'd1_database_create', {
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

    const accounts = await callForgeTool(ACCOUNT_TOKEN, 'access_apps_list', {
      account_or_zone: 'accounts'
    })
    const zoneWithoutId = await callForgeTool(ACCOUNT_TOKEN, 'access_apps_list', {
      account_or_zone: 'zones'
    })
    const zone = await callForgeTool(ACCOUNT_TOKEN, 'access_apps_list', {
      account_or_zone: 'zones',
      account_or_zone_id: ZONE_ID
    })

    expect(toolText(accounts)).toContain('app-1')
    expect(zoneWithoutId.result?.isError).toBe(true)
    expect(toolText(zoneWithoutId)).toBe('Missing path parameter: account_or_zone_id')
    expect(toolText(zone)).toContain('zone-app')
  })

  it("explains a refused call and names the token's account", async () => {
    server.use(
      http.get(`${API_BASE}/accounts/not-mine/workers/scripts`, () =>
        HttpResponse.json(cfError([{ code: 9109, message: 'Unauthorized' }]), { status: 403 })
      )
    )

    const result = await callForgeTool(ACCOUNT_TOKEN, 'workers_scripts_list', {
      account_id: 'not-mine'
    })

    expect(result.result?.isError).toBe(true)
    const text = toolText(result)
    expect(text).toContain(
      'Cloudflare API error: GET /accounts/not-mine/workers/scripts returned HTTP 403.'
    )
    expect(text).toContain("account_id not-mine is not this token's account.")
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

    expect(result.result?.tools?.map((tool) => tool.name)).not.toContain('workers_scripts_list')
  })
})

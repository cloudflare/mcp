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
  modernMcpRequest,
  parseMcpResult,
  toolText
} from './helpers/mcp'
import { server } from './setup/msw'

/**
 * The generated direct tools at /mcp?codemode=false&experimentalForge=true,
 * through the real worker:
 * auth, the transport, the generated tools and their request code, and
 * account resolution are real; the Cloudflare API is mocked with MSW.
 */

const ACCOUNT_ID = '00000000000000000000000000000001'
const ACCOUNT_TOKEN = 'acct-token-forge'
const ZONE_ID = '0000000000000000000000000000000z'
const FORGE_URL = `${MCP_URL}?codemode=false&experimentalForge=true`

type ListedTool = {
  name: string
  inputSchema: { properties?: Record<string, unknown>; required?: string[] }
  [key: string]: unknown
}

async function listForgeTools(token: string): Promise<ListedTool[]> {
  return listTools(token, FORGE_URL)
}

async function listTools(token: string, url: string): Promise<ListedTool[]> {
  const req = new Request(url, mcpToolListRequest(token))
  const result = (await parseMcpResult(await exports.default.fetch(req))) as unknown as {
    result?: { tools?: ListedTool[] }
  }
  return result.result?.tools ?? []
}

async function callForgeTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
  url = FORGE_URL
) {
  const req = new Request(url, mcpToolCallRequest(token, name, args))
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

describe('generated direct tools (?codemode=false&experimentalForge=true)', () => {
  it('lists docs, whoami and every generated tool, without their request code or response schemas', async () => {
    const tools = await listForgeTools(ACCOUNT_TOKEN)

    expect(tools.map((tool) => tool.name)).toEqual([
      'docs',
      'whoami',
      ...generatedTools.map((tool) => tool.name)
    ])
    const d1 = tools.find((tool) => tool.name === 'd1_list')!
    expect(d1.inputSchema.required ?? []).not.toContain('account_id')
    expect(generatedTools.find((tool) => tool.name === 'd1_list')?.responses).toBeDefined()
    for (const key of ['request', 'method', 'path', 'extensions', 'responses']) {
      expect(d1).not.toHaveProperty(key)
    }
  })

  it('gets the tool list from the service as one JSON string', async () => {
    const json = await env.FORGE_TOOLS.listJson()

    expect(typeof json).toBe('string')
    expect(JSON.parse(json).map((tool: { name: string }) => tool.name)).toEqual(
      generatedTools.map((tool) => tool.name)
    )
  })

  it('searches the pinned spec in a sandbox', async () => {
    await expect(
      env.FORGE_TOOLS.search(
        `async () => spec.paths['/accounts/{account_id}/d1/database'].get.summary`
      )
    ).resolves.toEqual({ result: 'List D1 Databases' })
    await expect(
      env.FORGE_TOOLS.search(`async () => { throw new Error('nothing matched') }`)
    ).resolves.toEqual({ error: 'nothing matched' })
  })

  it("streams the pinned release's spec artifacts", async () => {
    const text = async (name: Parameters<typeof env.FORGE_TOOLS.specArtifact>[0]) =>
      new Response(await env.FORGE_TOOLS.specArtifact(name)).text()

    const spec = JSON.parse(await text('spec.json')) as {
      paths: Record<string, Record<string, { 'x-api-token-group'?: string[] }>>
    }
    expect(spec.paths['/accounts/{account_id}/d1/database'].get['x-api-token-group']).toContain(
      'D1 Read'
    )
    expect(JSON.parse(await text('products.json'))).toContain('workers')
    const mcpTools = JSON.parse(await text('mcp-tools.json')) as { name: string }[]
    expect(mcpTools.length).toBeGreaterThan(1000)
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

  it('keeps the mcp-tools.json direct tools for ?codemode=false without the flag', async () => {
    const names = (await listTools(ACCOUNT_TOKEN, `${MCP_URL}?codemode=false`)).map(
      (tool) => tool.name
    )

    expect(names).not.toContain('d1_list')
  })

  it.each(['?experimentalForge=true', '?forge=true'])('serves Code Mode for %s', async (query) => {
    const names = (await listTools(ACCOUNT_TOKEN, `${MCP_URL}${query}`)).map((tool) => tool.name)

    expect(names).toEqual(['docs', 'search', 'execute', 'whoami'])
  })

  describe('results', () => {
    // ~94K characters as pretty JSON, well past the ~24K-character cap.
    const SCRIPTS = Array.from({ length: 2_000 }, (_, i) => ({ id: `worker-${i}`, i }))

    beforeEach(() => {
      server.use(
        http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/workers/scripts`, () =>
          HttpResponse.json(cfSuccess(SCRIPTS))
        )
      )
    })

    it('returns the whole response by default', async () => {
      const result = await callForgeTool(ACCOUNT_TOKEN, 'workers_legacy_scripts_list', {
        account_id: ACCOUNT_ID
      })

      expect(JSON.parse(toolText(result))).toEqual(cfSuccess(SCRIPTS))
    })

    it('caps the response with ?truncateToolResult=true', async () => {
      const result = await callForgeTool(
        ACCOUNT_TOKEN,
        'workers_legacy_scripts_list',
        { account_id: ACCOUNT_ID },
        `${FORGE_URL}&truncateToolResult=true`
      )
      const text = toolText(result)

      expect(text.length).toBeLessThanOrEqual(24_000)
      expect(JSON.parse(text).result.at(-1)).toMatch(/^--- TRUNCATED --- [\d,]+ more items$/)
    })
  })

  describe('output schemas (&experimentalOutputSchema=true)', () => {
    const OUTPUT_URL = `${FORGE_URL}&experimentalOutputSchema=true`
    const D1_OUTPUT = generatedTools.find((tool) => tool.name === 'd1_list')!.outputSchema

    async function listModern(url: string): Promise<ListedTool[]> {
      const req = modernMcpRequest(ACCOUNT_TOKEN, 'tools/list', {}, { url })
      const result = (await parseMcpResult(await exports.default.fetch(req))) as unknown as {
        result?: { tools?: ListedTool[] }
      }
      return result.result?.tools ?? []
    }

    async function callModern(name: string, args: Record<string, unknown>, url = OUTPUT_URL) {
      const req = modernMcpRequest(ACCOUNT_TOKEN, 'tools/call', { name, arguments: args }, { url })
      return parseMcpResult(await exports.default.fetch(req))
    }

    it("lists each tool's generated output schema to 2026-07-28 requests", async () => {
      const tools = await listModern(OUTPUT_URL)

      expect(D1_OUTPUT).toBeDefined()
      expect(tools.find((tool) => tool.name === 'd1_list')?.outputSchema).toEqual(D1_OUTPUT)
      expect(tools.find((tool) => tool.name === 'd1_list')).not.toHaveProperty('responses')
      const withOutput = generatedTools.filter((tool) => tool.outputSchema).map((tool) => tool.name)
      expect(tools.filter((tool) => tool.outputSchema).map((tool) => tool.name)).toEqual([
        'docs',
        'whoami',
        ...withOutput
      ])
    })

    it.each([
      ['a 2025-era request', () => listTools(ACCOUNT_TOKEN, OUTPUT_URL)],
      ['a request without the parameter', () => listModern(FORGE_URL)],
      [
        'the endpoint tools',
        () => listModern(`${MCP_URL}?codemode=false&experimentalOutputSchema=true`)
      ],
      [
        'Code Mode',
        () => listModern(`${MCP_URL}?experimentalForge=true&experimentalOutputSchema=true`)
      ]
    ])('lists no generated output schemas to %s', async (_case, list) => {
      const tools = await list()

      expect(tools.length).toBeGreaterThan(0)
      const named = tools.filter((tool) => tool.outputSchema).map((tool) => tool.name)
      expect(named.filter((name) => name !== 'docs' && name !== 'whoami')).toEqual([])
    })

    describe('calls', () => {
      // ~94K characters as pretty JSON, well past the ~24K-character cap.
      const DATABASES = Array.from({ length: 2_000 }, (_, i) => ({ uuid: `db-${i}`, i }))

      beforeEach(() => {
        server.use(
          http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/d1/database`, () =>
            HttpResponse.json(cfSuccess(DATABASES))
          ),
          http.get(`${API_BASE}/accounts/not-mine/d1/database`, () =>
            HttpResponse.json(cfError([{ code: 9109, message: 'Unauthorized' }]), { status: 403 })
          )
        )
      })

      it('returns a paginated list whole, even when the text is truncated', async () => {
        const result = await callModern('d1_list', {}, `${OUTPUT_URL}&truncateToolResult=true`)

        expect(result.result?.isError).toBeFalsy()
        expect(result.result?.structuredContent).toEqual(cfSuccess(DATABASES))
        expect(toolText(result)).toMatch(/--- TRUNCATED ---/)
      })

      it('returns the whole body, envelope included, as its output schema describes', async () => {
        const subdomain = cfSuccess({ subdomain: 'acme' })
        server.use(
          http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/workers/subdomain`, () =>
            HttpResponse.json(subdomain)
          )
        )

        const result = await callModern('workers_subdomains_get', {})

        expect(result.result?.structuredContent).toEqual(subdomain)
        expect(JSON.parse(toolText(result))).toEqual(subdomain)
        const tool = generatedTools.find((t) => t.name === 'workers_subdomains_get')!
        expect(JSON.stringify(tool.outputSchema)).toContain('"result"')
      })

      it('leaves structuredContent out of an error', async () => {
        const result = await callModern('d1_list', { account_id: 'not-mine' })

        expect(result.result?.isError).toBe(true)
        expect(result.result).not.toHaveProperty('structuredContent')
      })

      it.each([
        ['a 2025-era request', () => callForgeTool(ACCOUNT_TOKEN, 'd1_list', {}, OUTPUT_URL)],
        ['a request without the parameter', () => callModern('d1_list', {}, FORGE_URL)]
      ])('leaves structuredContent out of %s', async (_case, call) => {
        const result = await call()

        expect(result.result?.isError).toBeFalsy()
        expect(result.result).not.toHaveProperty('structuredContent')
      })
    })
  })
})

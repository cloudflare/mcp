import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CALL_ID_META_KEY, CallIdSchema } from '../src/tool-telemetry'
import { DOCS_TOOL } from '../src/tools/docs-search'
import { WHOAMI_TOOL } from '../src/tools/whoami'
import { SEND_FEEDBACK_TOOL } from '../src/tools/send-feedback'
import { operation, tools as generatedTools } from '../src/generated/forge-mcp'
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
 * The generated direct tools at /mcp?codemode=false,
 * through the real worker:
 * auth, the transport, the generated tools and their request code, and
 * account resolution are real; the Cloudflare API is mocked with MSW.
 */

const ACCOUNT_ID = '00000000000000000000000000000001'
const ACCOUNT_TOKEN = 'acct-token-forge'
const ZONE_ID = '0000000000000000000000000000000z'
const FORGE_URL = `${MCP_URL}?codemode=false`

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
  vi.restoreAllMocks()
  await clearSpec()
  await clearKv(env.OAUTH_KV)
})

describe('generated direct tools (?codemode=false)', () => {
  it('lists docs, whoami, feedback and generated tools without request code or response schemas', async () => {
    const tools = await listForgeTools(ACCOUNT_TOKEN)

    expect(tools.map((tool) => tool.name)).toEqual([
      'docs',
      'whoami',
      'send_feedback',
      ...generatedTools.map((tool) => tool.name)
    ])
    const d1 = tools.find((tool) => tool.name === 'd1_list')!
    expect(tools.find((tool) => tool.name === 'docs')).toEqual(DOCS_TOOL)
    expect(tools.find((tool) => tool.name === 'whoami')).toEqual(WHOAMI_TOOL)
    expect(tools.find((tool) => tool.name === 'send_feedback')).toEqual(SEND_FEEDBACK_TOOL)
    expect(d1.inputSchema.properties?.telemetry).toBeDefined()
    expect(d1.inputSchema.required ?? []).not.toContain('path')
    expect(d1.inputSchema.properties?.path).not.toHaveProperty('required')
    expect(
      operation(generatedTools.find((tool) => tool.name === 'd1_list')!).responses
    ).toBeDefined()
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

  it("searches the pinned release's spec, whose schemas are the API's own", async () => {
    const { result } = await env.FORGE_TOOLS.search(`async () => {
      const subdomain = spec.paths['/accounts/{account_id}/workers/subdomain'].get.responses['200'];
      return {
        permissions: spec.paths['/accounts/{account_id}/d1/database'].get['x-api-token-group'],
        schema: JSON.stringify(subdomain.content['application/json'].schema),
        resultInfo: 'x-result-info' in subdomain
      };
    }`)
    const found = result as { permissions: string[]; schema: string; resultInfo: boolean }
    expect(found.permissions).toContain('D1 Read')
    // Built with the current processSpec(): schemas are the API's own, envelope included.
    expect(found.schema).toContain('"success"')
    expect(found.resultInfo).toBe(false)
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

    const result = await callForgeTool(ACCOUNT_TOKEN, 'd1_list', {
      query: { name: 'prod', per_page: 5 }
    })

    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).toContain('db-1')
    expect(called?.searchParams.get('name')).toBe('prod')
    expect(called?.searchParams.get('per_page')).toBe('5')
    expect(auth).toBe(`Bearer ${ACCOUNT_TOKEN}`)
  })

  it('sends a body in the media type its value fits: text as it is, an object as multipart', async () => {
    const KV = `${API_BASE}/accounts/${ACCOUNT_ID}/storage/kv/namespaces/ns/values/greeting`
    const sent: { type: string | null; text?: string; form?: FormData }[] = []
    server.use(
      http.put(KV, async ({ request }) => {
        const type = request.headers.get('Content-Type')
        sent.push(
          type?.startsWith('multipart/form-data')
            ? { type, form: await request.formData() }
            : { type, text: await request.text() }
        )
        return HttpResponse.json(cfSuccess(null))
      })
    )
    const path = { namespace_id: 'ns', key_name: 'greeting' }

    await callForgeTool(ACCOUNT_TOKEN, 'kv_keys_put', { path, body: 'hello' })
    await callForgeTool(ACCOUNT_TOKEN, 'kv_keys_put', {
      path,
      body: { value: 'hello', metadata: { owner: 'bench' } }
    })

    expect(sent[0]).toEqual({ type: 'application/octet-stream', text: 'hello' })
    expect(sent[1].type).toMatch(/^multipart\/form-data; boundary=/)
    expect(sent[1].form?.get('value')).toBe('hello')
    expect(sent[1].form?.get('metadata')).toBe('{"owner":"bench"}')
  })

  it('sends the body argument as JSON', async () => {
    let body: unknown
    let sent: { url: string; headers: Headers } | undefined
    server.use(
      http.post(`${API_BASE}/accounts/${ACCOUNT_ID}/d1/database`, async ({ request }) => {
        body = await request.json()
        sent = { url: request.url, headers: request.headers }
        return HttpResponse.json(cfSuccess({ uuid: 'db-2' }))
      })
    )

    const result = await callForgeTool(ACCOUNT_TOKEN, 'd1_create', {
      body: { name: 'prod', primary_location_hint: 'weur' },
      telemetry: { intent: 'Find the database for checkout errors.' }
    })

    expect(result.result?.isError).toBeFalsy()
    expect(body).toEqual({ name: 'prod', primary_location_hint: 'weur' })
    expect(sent?.url).not.toContain('telemetry')
    expect([...sent!.headers.keys()]).not.toContain('telemetry')
    expect([...sent!.headers.values()].join(' ')).not.toContain('checkout errors')
    expect(CallIdSchema.safeParse(result.result?._meta?.[CALL_ID_META_KEY]).success).toBe(true)
  })

  it.each([
    null,
    'intent',
    [],
    { intent: '' },
    { intent: '   ' },
    { intent: 12 },
    { intent: 'a'.repeat(1025) },
    { unexpected: true }
  ])('rejects invalid telemetry: %j', async (telemetry) => {
    const result = await callForgeTool(ACCOUNT_TOKEN, 'd1_list', { telemetry })

    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toContain('Invalid arguments for tool d1_list')
    expect(result.result?.content?.at(-1)?.text).toBe(
      `Call ID: ${result.result?._meta?.[CALL_ID_META_KEY]}`
    )
  })

  it('counts each generated-tool and feedback invocation once', async () => {
    const metrics = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/d1/database`, () =>
        HttpResponse.json(cfSuccess([]))
      )
    )
    const args = { query: { name: 'prod' } }
    const success = await callForgeTool(ACCOUNT_TOKEN, 'd1_list', {
      ...args,
      telemetry: { intent: 'Find production databases.' }
    })
    await callForgeTool(ACCOUNT_TOKEN, 'd1_list', { telemetry: { intent: '' } })
    await callForgeTool(ACCOUNT_TOKEN, 'send_feedback', { feedback: 'A capability is missing.' })
    await callForgeTool(ACCOUNT_TOKEN, 'send_feedback', {})

    expect(success.result?.isError, JSON.stringify(success)).toBeFalsy()
    const calls = metrics.mock.calls
      .map(([dp]) => dp)
      .filter((dp) => dp !== undefined)
      .filter((dp) => dp.indexes?.[0] === 'tool_call')
    expect(calls.map((dp) => [dp.blobs?.[3], dp.doubles?.[0]])).toEqual([
      ['d1_list', undefined],
      ['d1_list', -1],
      ['send_feedback', undefined],
      ['send_feedback', -1]
    ])
  })

  it('submits feedback with an earlier error ID, or without a prior call, locally', async () => {
    const error = await callForgeTool(ACCOUNT_TOKEN, 'd1_list', { unexpected: true })
    const callId = error.result?._meta?.[CALL_ID_META_KEY]
    const feedback = await callForgeTool(ACCOUNT_TOKEN, 'send_feedback', {
      feedback: 'The argument layout was confusing.',
      context: { tool: 'd1_list', call_id: callId },
      telemetry: { intent: 'Explain the workaround.' }
    })
    const missing = await callForgeTool(ACCOUNT_TOKEN, 'send_feedback', {
      feedback: 'I need a missing capability.'
    })

    expect(feedback.result?.isError).toBeFalsy()
    expect(missing.result?.isError).toBeFalsy()
    expect(toolText(feedback)).toContain('trace sampling and retention')
    expect(feedback.result?._meta?.[CALL_ID_META_KEY]).not.toBe(callId)
  })

  it('returns a correlated tool error when parsing the API response throws', async () => {
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/d1/database`, () =>
        HttpResponse.text('{ malformed', { headers: { 'Content-Type': 'application/json' } })
      )
    )
    const result = await callForgeTool(ACCOUNT_TOKEN, 'd1_list', {
      telemetry: { intent: 'Find production databases.' }
    })

    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toMatch(/JSON|Expected|Unexpected/)
    expect(result.result?.content?.at(-1)?.text).toBe(
      `Call ID: ${result.result?._meta?.[CALL_ID_META_KEY]}`
    )
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
      callForgeTool(ACCOUNT_TOKEN, 'zeroTrust_access_applications_list', args)

    const accounts = await call({ path: { account_or_zone: 'accounts' } })
    const zoneWithoutId = await call({ path: { account_or_zone: 'zones' } })
    const zone = await call({ path: { account_or_zone: 'zones', account_or_zone_id: ZONE_ID } })

    expect(toolText(accounts)).toContain('app-1')
    expect(zoneWithoutId.result?.isError).toBe(true)
    expect(toolText(zoneWithoutId)).toBe('Missing path parameter: account_or_zone_id')
    expect(toolText(zone)).toContain('zone-app')
  })

  it('asks for path.account_id when the session has several accounts', async () => {
    mockIdentityProbe({
      user: { id: 'u1', email: 'u@example.com' },
      accounts: [
        { id: ACCOUNT_ID, name: 'Acc One' },
        { id: '00000000000000000000000000000002', name: 'Acc Two' }
      ]
    })

    const result = await callForgeTool('multi-account-user-token-forge', 'd1_list', {})

    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toContain(
      "No account selected. Pass path.account_id with one of this session's accounts:"
    )
    expect(toolText(result)).toContain(`- ${ACCOUNT_ID} (Acc One)`)
  })

  it('refuses a parameter passed at the top level instead of ignoring it', async () => {
    const result = await callForgeTool(ACCOUNT_TOKEN, 'd1_list', { per_page: 5 })

    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toContain(
      'Property "per_page" does not match additional properties schema'
    )
  })

  it("explains a refused call and names the token's account", async () => {
    server.use(
      http.get(`${API_BASE}/accounts/not-mine/d1/database`, () =>
        HttpResponse.json(cfError([{ code: 9109, message: 'Unauthorized' }]), { status: 403 })
      )
    )

    const result = await callForgeTool(ACCOUNT_TOKEN, 'd1_list', {
      path: { account_id: 'not-mine' }
    })

    expect(result.result?.isError).toBe(true)
    const text = toolText(result)
    expect(text).toContain(
      'Cloudflare API error: GET /accounts/not-mine/d1/database returned HTTP 403.'
    )
    expect(text).toContain("account_id not-mine is not this token's account.")
  })

  it('says how long Cloudflare asks to wait when it rate limits a call', async () => {
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/d1/database`, () =>
        HttpResponse.json(cfError([{ code: 10429, message: 'rate limited' }]), {
          status: 429,
          headers: { 'Retry-After': '60', Ratelimit: '"default";r=0;t=60' }
        })
      )
    )

    const result = await callForgeTool(ACCOUNT_TOKEN, 'd1_list', {})

    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toContain(
      'Cloudflare rate limited this request (limit "default") and asks to wait 60 seconds.'
    )
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

  describe('responses that are not JSON', () => {
    // A JPEG's first bytes: not valid UTF-8, so reading them as text loses them (#400).
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x80, 0x81, 0xfe])
    const KV_VALUE = `/accounts/${ACCOUNT_ID}/storage/kv/namespaces/ns/values/k`
    const getKvValue = () =>
      callForgeTool(ACCOUNT_TOKEN, 'kv_keys_get', {
        path: { account_id: ACCOUNT_ID, namespace_id: 'ns', key_name: 'k' }
      })
    const serve = (path: string, body: BodyInit, type: string | undefined, status = 200) =>
      server.use(
        http.all(
          `${API_BASE}${path}`,
          () => new HttpResponse(body, { status, headers: type ? { 'Content-Type': type } : {} })
        )
      )
    const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))

    it('returns a binary KV value as an embedded resource, byte for byte', async () => {
      // Every byte value, many times over: larger than one base64 chunk.
      const value = Uint8Array.from({ length: 100_000 }, (_, i) => i % 256)
      serve(KV_VALUE, value, 'application/octet-stream')

      const { result } = await getKvValue()

      expect(result?.isError).toBeFalsy()
      expect(result?.content).toHaveLength(1)
      const [block] = result!.content as unknown as [
        { type: string; resource: { uri: string; mimeType: string; blob: string } }
      ]
      expect(block.type).toBe('resource')
      expect(block.resource.uri).toBe(`${API_BASE}${KV_VALUE}`)
      expect(block.resource.mimeType).toBe('application/octet-stream')
      expect(bytesOf(block.resource.blob)).toEqual(value)
    })

    it('returns a text KV value as text, though KV serves it as application/octet-stream', async () => {
      serve(KV_VALUE, 'hello, kv ✓', 'application/octet-stream')

      const { result } = await getKvValue()

      expect(result?.content).toEqual([{ type: 'text', text: 'hello, kv ✓' }])
    })

    it.each([
      ['image/jpeg', 'images_getBlob', `/accounts/${ACCOUNT_ID}/images/v1/img/blob`, 'image'],
      ['IMAGE/PNG; q=1', 'images_getBlob', `/accounts/${ACCOUNT_ID}/images/v1/img/blob`, 'image'],
      ['audio/mpeg', 'images_getBlob', `/accounts/${ACCOUNT_ID}/images/v1/img/blob`, 'audio']
    ])('returns %s as MCP %s content', async (type, tool, path, kind) => {
      serve(path, JPEG, type)

      const { result } = await callForgeTool(ACCOUNT_TOKEN, tool, {
        path: { account_id: ACCOUNT_ID, image_id: 'img' }
      })

      const [block] = result!.content as unknown as [
        { type: string; data: string; mimeType: string }
      ]
      expect(block.type).toBe(kind)
      expect(block.mimeType).toBe(type.split(';')[0].toLowerCase())
      expect(bytesOf(block.data)).toEqual(JPEG)
    })

    it.each([
      ['application/pdf', 'application/pdf'],
      ['application/zip', 'application/zip'],
      [undefined, 'application/octet-stream']
    ])('returns %s bytes from R2 as an embedded resource', async (type, mimeType) => {
      const path = `/accounts/${ACCOUNT_ID}/r2/buckets/b/objects/report`
      serve(path, JPEG, type)

      const { result } = await callForgeTool(ACCOUNT_TOKEN, 'r2_objects_get', {
        path: { account_id: ACCOUNT_ID, bucket_name: 'b', object_key: 'report' },
        headers: { 'cf-r2-jurisdiction': 'eu' }
      })

      const [block] = result!.content as unknown as [
        { type: string; resource: { mimeType: string; blob: string } }
      ]
      expect(block.type).toBe('resource')
      expect(block.resource.mimeType).toBe(mimeType)
      expect(bytesOf(block.resource.blob)).toEqual(JPEG)
    })

    it.each([
      ['text/csv', 'a,b\n1,2'],
      ['application/x-ndjson', '{"a":1}\n{"a":2}'],
      ['image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
      ['application/octet-stream', '']
    ])('returns a %s body that is text as text', async (type, body) => {
      serve(KV_VALUE, body, type)

      const { result } = await getKvValue()

      expect(result?.content).toEqual([{ type: 'text', text: body }])
    })

    it('does not cut binary with ?truncateToolResult=true', async () => {
      const value = Uint8Array.from({ length: 100_000 }, (_, i) => 128 + (i % 128))
      serve(KV_VALUE, value, 'application/octet-stream')

      const { result } = await callForgeTool(
        ACCOUNT_TOKEN,
        'kv_keys_get',
        { path: { account_id: ACCOUNT_ID, namespace_id: 'ns', key_name: 'k' } },
        `${FORGE_URL}&truncateToolResult=true`
      )

      const [block] = result!.content as unknown as [{ resource: { blob: string } }]
      expect(bytesOf(block.resource.blob)).toEqual(value)
    })

    it('names a binary error body by its size and type instead of sending it', async () => {
      serve(KV_VALUE, JPEG, 'application/octet-stream', 500)

      const result = await getKvValue()

      expect(result.result?.isError).toBe(true)
      expect(result.result?.content).toHaveLength(1)
      expect(toolText(result)).toContain(`GET ${KV_VALUE} returned HTTP 500`)
      expect(toolText(result)).toContain('[11 bytes of application/octet-stream]')
    })
  })

  it('reports an unknown tool', async () => {
    const result = await callForgeTool(ACCOUNT_TOKEN, 'nope', {})

    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toBe('Tool nope not found')
  })

  it('serves the forge tools for ?codemode=false, and Code Mode without it', async () => {
    const direct = (await listTools(ACCOUNT_TOKEN, `${MCP_URL}?codemode=false`)).map((t) => t.name)
    const codemode = (await listTools(ACCOUNT_TOKEN, MCP_URL)).map((t) => t.name)

    expect(direct).toContain('d1_list')
    expect(codemode).toEqual(['docs', 'search', 'execute', 'whoami'])
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
        path: { account_id: ACCOUNT_ID }
      })

      expect(JSON.parse(toolText(result))).toEqual(cfSuccess(SCRIPTS))
    })

    it('caps the response with ?truncateToolResult=true', async () => {
      const result = await callForgeTool(
        ACCOUNT_TOKEN,
        'workers_legacy_scripts_list',
        { path: { account_id: ACCOUNT_ID } },
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
      ['Code Mode', () => listModern(`${MCP_URL}?experimentalOutputSchema=true`)]
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
        const result = await callModern('d1_list', { path: { account_id: 'not-mine' } })

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

import { env, exports } from 'cloudflare:workers'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { http, HttpResponse } from 'msw'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUTH_PROPS_VERSION, type AuthProps } from '../src/auth/types'
import { DIRECT_CONNECTION, type Connection } from '../src/api-permissions'
import { ScopeChallenge } from '../src/scope-challenge'
import { defineMcpApp, MCP_APP_MIME, type AppContext } from '../src/mcp-apps/define'
import {
  ApiReadError,
  ApiReadUnsupported,
  apiReader,
  graphqlRefused
} from '../src/mcp-apps/api-read'
import { MCP_APPS, registerMcpApps } from '../src/mcp-apps/registry'
import { localDirectTools } from '../src/tools/forge-tools'
import { API_BASE, cfError, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, modernMcpRequest, parseMcpResult } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'

const ACCOUNT_ID = '023e105f4ecef8ad9ca31a8372d0c353'
const props: AuthProps = {
  type: 'account_token',
  accessToken: 'app-token',
  account: { id: ACCOUNT_ID, name: 'Apps Co' }
}

function context(connection: Connection = DIRECT_CONNECTION): AppContext {
  return { props, connection, scopeChallenge: new ScopeChallenge(undefined) }
}

/** A fixture App: reads the account's Worker names. */
const fixture = defineMcpApp({
  name: 'fixture_app',
  title: 'Fixture App',
  description: 'Lists Worker names. Test fixture only.',
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  input: z.strictObject({ prefix: z.string().optional() }),
  output: z.strictObject({ kind: z.literal('fixture'), names: z.array(z.string()) }),
  resource: { uri: 'ui://cloudflare/fixture.html', name: 'Fixture', html: '<p>fixture</p>' },
  async run(input, ctx, signal) {
    const scripts = await apiReader(ctx, signal, 'fixture_app')
      .get(
        `/accounts/${ACCOUNT_ID}/workers/scripts`,
        z.object({ result: z.array(z.object({ id: z.string() })) })
      )
      .catch((error: unknown) => error)
    if (scripts instanceof ApiReadError)
      return { ok: false, text: scripts.text, meta: scripts.result._meta }
    if (scripts instanceof Error) throw scripts
    const names = (scripts as { result: { id: string }[] }).result
      .map((s) => s.id)
      .filter((id) => !input.prefix || id.startsWith(input.prefix))
    return { ok: true, value: { kind: 'fixture' as const, names } }
  }
})

async function connected(apps = [fixture]) {
  const mcp = new McpServer({ name: 'apps-test', version: '1.0.0' })
  registerMcpApps(mcp, context(), apps)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)])
  return client
}

beforeEach(async () => {
  await seedSpec({
    '/accounts/{account_id}/workers/scripts': {
      get: { 'x-api-token-group': ['Workers Scripts Read'] }
    }
  })
})

afterEach(async () => {
  await clearSpec()
  await clearKv(env.OAUTH_KV)
})

describe('defineMcpApp', () => {
  it('describes the tool and its App resource', () => {
    expect(fixture.tool).toMatchObject({
      name: 'fixture_app',
      _meta: {
        ui: { resourceUri: 'ui://cloudflare/fixture.html' },
        'ui/resourceUri': 'ui://cloudflare/fixture.html'
      },
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', required: ['kind', 'names'] }
    })
    expect(fixture.resource).toEqual({
      descriptor: { uri: 'ui://cloudflare/fixture.html', name: 'Fixture', mimeType: MCP_APP_MIME },
      content: {
        uri: 'ui://cloudflare/fixture.html',
        mimeType: MCP_APP_MIME,
        text: '<p>fixture</p>',
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } }
      }
    })
  })

  it('lists in Code Mode with the same definition the direct tools send', async () => {
    const client = await connected()
    const listed = (await client.listTools()).tools
    expect(JSON.parse(JSON.stringify(listed))).toEqual([
      expect.objectContaining({
        name: fixture.tool.name,
        _meta: fixture.tool._meta,
        inputSchema: fixture.tool.inputSchema,
        outputSchema: fixture.tool.outputSchema
      })
    ])
  })

  it('returns the validated result as text and structuredContent', async () => {
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/workers/scripts`, () =>
        HttpResponse.json(cfSuccess([{ id: 'api-mcp' }, { id: 'docs' }]))
      )
    )
    const client = await connected()
    const result = await client.callTool({ name: 'fixture_app', arguments: { prefix: 'api' } })
    expect(result.structuredContent).toEqual({ kind: 'fixture', names: ['api-mcp'] })
    expect(result.content).toEqual([
      { type: 'text', text: '{"kind":"fixture","names":["api-mcp"]}' }
    ])
  })

  it('refuses invalid arguments without calling the API', async () => {
    const result = await fixture.call({ prefix: 1 }, context(), {
      mcpReq: { signal: new AbortController().signal }
    } as never)
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('Invalid arguments for tool fixture_app')
  })
})

describe('apiReader', () => {
  const signal = new AbortController().signal

  it('explains a refused read like the direct tools', async () => {
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/workers/scripts`, () =>
        HttpResponse.json(cfError([{ code: 10000, message: 'Authentication error' }]), {
          status: 403
        })
      )
    )
    const error = await apiReader(context({ kind: 'oauth', scopes: [] }), signal, 'test')
      .get(`/accounts/${ACCOUNT_ID}/workers/scripts`, z.unknown())
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiReadError)
    const text = (error as ApiReadError).text
    expect(text).toContain(`GET /accounts/${ACCOUNT_ID}/workers/scripts returned HTTP 403`)
    expect(text).toContain('workers-scripts.read')
  })

  it('sends the credential only to the Cloudflare API', async () => {
    let authorization: string | null = null
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/workers/scripts`, ({ request }) => {
        authorization = request.headers.get('authorization')
        return HttpResponse.json(cfSuccess([]))
      })
    )
    await apiReader(context(), signal, 'test').get(
      `/accounts/${ACCOUNT_ID}/workers/scripts`,
      z.unknown()
    )
    expect(authorization).toBe('Bearer app-token')
  })

  it('refuses a body over the read limit', async () => {
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/workers/scripts`, () =>
        HttpResponse.text('x'.repeat(1024 * 1024 + 1))
      )
    )
    await expect(
      apiReader(context(), signal, 'test').get(
        `/accounts/${ACCOUNT_ID}/workers/scripts`,
        z.unknown()
      )
    ).rejects.toBeInstanceOf(ApiReadUnsupported)
  })

  it('parses GraphQL data', async () => {
    server.use(
      http.post(`${API_BASE}/graphql`, () =>
        HttpResponse.json({ data: { viewer: { ok: true } }, errors: null })
      )
    )
    const data = await apiReader(context(), signal, 'test').graphql(
      '{ viewer { ok } }',
      {},
      'account',
      z.object({ viewer: z.object({ ok: z.boolean() }) })
    )
    expect(data).toEqual({ viewer: { ok: true } })
  })

  it('explains an account GraphQL refusal as missing Account Analytics Read', async () => {
    server.use(
      http.post(`${API_BASE}/graphql`, () =>
        HttpResponse.json({ data: null, errors: [{ message: 'authorization denied' }] })
      )
    )
    const error = await apiReader(context({ kind: 'oauth', scopes: [] }), signal, 'test')
      .graphql('{ viewer { ok } }', {}, 'account', z.unknown())
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiReadError)
    expect((error as ApiReadError).text).toContain('account-analytics.read')
  })

  it('does not call a GraphQL quota error a refusal', async () => {
    const quota = 'cannot request a time range wider than 4w4d'
    server.use(
      http.post(`${API_BASE}/graphql`, () =>
        HttpResponse.json({ data: null, errors: [{ message: quota }] })
      )
    )
    const error = await apiReader(context({ kind: 'oauth', scopes: [] }), signal, 'test')
      .graphql('{ viewer { ok } }', {}, 'account', z.unknown())
      .catch((e: unknown) => e)
    const text = (error as ApiReadError).text
    expect(text).toContain(quota)
    expect(text).not.toContain('scope')
  })

  it.each([
    [['authorization denied'], 'account', true],
    [["does not have permission 'com.cloudflare.api.account.zone.analytics.read'"], 'zone', true],
    [['authorization denied'], 'zone', false],
    [['unknown field'], 'account', false]
  ] as const)('graphqlRefused(%j, %s) is %s', (messages, dataset, refused) => {
    expect(graphqlRefused(messages, dataset)).toBe(refused)
  })
})

describe('MCP Apps in the worker', () => {
  const TOKEN = 'apps-worker-token'

  beforeEach(() => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Apps Co' }] })
  })

  async function modern(method: string, params: Record<string, unknown> = {}, url = MCP_URL) {
    const response = await exports.default.fetch(modernMcpRequest(TOKEN, method, params, { url }))
    return (await parseMcpResult(response)) as {
      result?: { tools?: { name: string }[]; resources?: { uri: string }[] }
    }
  }

  it('lists every registered App in both tool modes, after docs and whoami', async () => {
    const names = MCP_APPS.map((app) => app.tool.name)
    const codemode = await modern('tools/list')
    expect(codemode.result?.tools?.map((t) => t.name)).toEqual([
      'docs',
      'search',
      'execute',
      'whoami',
      ...names
    ])
    expect(localDirectTools().map((t) => t.name)).toEqual(['docs', 'whoami', ...names])
  })

  it('lists every registered App resource', async () => {
    const body = await modern('resources/list')
    const uris = body.result?.resources?.map((r) => r.uri) ?? []
    for (const app of MCP_APPS) expect(uris).toContain(app.resource.descriptor.uri)
  })
})

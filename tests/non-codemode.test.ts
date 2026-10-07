import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { createServer } from '../src/server'
import type { OperationInfo } from '../src/openapi'
import { AUTH_PROPS_VERSION, type AuthProps } from '../src/auth/types'
import { DOCS_TOOL, registerDocsTool } from '../src/tools/docs-search'
import { clearSpec, seedSpec } from './helpers/spec'
import { directTool } from './helpers/direct-tools'

// Use minimal retry config so tests don't wait for real backoff delays
vi.mock('../src/utils/fetch-retry', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/utils/fetch-retry')>()
  return {
    ...original,
    fetchWithRetry: (input: RequestInfo, init?: RequestInit) =>
      original.fetchWithRetry(input, init, { maxRetries: 0 })
  }
})

async function withClient<T>(
  server: McpServer,
  action: (client: Client) => Promise<T>
): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    return await action(client)
  } finally {
    await client.close()
    await server.close()
  }
}

async function listTools(server: McpServer) {
  return withClient(server, async (client) => (await client.listTools()).tools)
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>
): Promise<any> {
  return withClient(server, (client) => client.callTool({ name, arguments: args }))
}

describe('precomputed tool contracts', () => {
  it('keeps the docs wire definition identical to the SDK-generated definition', async () => {
    const server = new McpServer({ name: 'docs-schema-test', version: '1.0.0' })
    registerDocsTool(server)

    expect(JSON.parse(JSON.stringify(await listTools(server)))).toEqual([DOCS_TOOL])
  })

  it('includes annotations.title on the docs tool', async () => {
    const server = new McpServer({ name: 'docs-title-test', version: '1.0.0' })
    registerDocsTool(server)

    const [tool] = await listTools(server)
    expect(tool.name).toBe('docs')
    expect(tool.title).toBe('Cloudflare Docs Search')
    expect(tool.annotations).toMatchObject({
      title: 'Cloudflare Docs Search',
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false
    })
  })
})

const WORKERS_LIST = directTool({
  name: 'workers_scripts_list',
  title: 'List Workers',
  path: '/accounts/{account_id}/workers/scripts',
  query: ['page', 'per_page', 'tags']
})
const WORKER_GET = directTool({
  name: 'workers_scripts_get',
  path: '/accounts/{account_id}/workers/scripts/{script_name}'
})
const WORKER_UPDATE = directTool({
  name: 'workers_scripts_update',
  method: 'PUT',
  path: '/accounts/{account_id}/workers/scripts/{script_name}',
  headers: ['If-Match'],
  body: ['application/javascript', 'multipart/form-data']
})
const D1_CREATE = directTool({
  name: 'd1_database_create',
  method: 'POST',
  path: '/accounts/{account_id}/d1/database',
  body: 'application/json'
})
const DNS_DELETE = directTool({
  name: 'dns_records_delete',
  method: 'DELETE',
  path: '/zones/{zone_id}/dns_records/{record_id}'
})
const DNS_EDIT = directTool({
  name: 'dns_records_edit',
  method: 'PATCH',
  path: '/zones/{zone_id}/dns_records/{record_id}',
  query: ['comment'],
  body: 'application/json'
})
const KV_GET = directTool({
  name: 'kv_namespaces_values_get',
  path: '/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/{key_name}'
})
const USER_GET = directTool({ name: 'user_get', path: '/user' })
const TOKEN_FORM = directTool({
  name: 'tokens_form',
  method: 'POST',
  path: '/accounts/{account_id}/tokens/form',
  body: ['application/x-www-form-urlencoded', 'multipart/form-data']
})

const ALL_TOOLS = [
  WORKERS_LIST,
  WORKER_GET,
  WORKER_UPDATE,
  D1_CREATE,
  DNS_DELETE,
  DNS_EDIT,
  KV_GET,
  USER_GET,
  TOKEN_FORM
]

describe('createServer with codemode=false', () => {
  // Account-token session pinned to a single account id (token fixed to that account).
  function acctProps(accountId: string): AuthProps {
    return {
      type: 'account_token',
      accessToken: 'test-token',
      account: { id: accountId, name: accountId }
    }
  }

  // User token with no account context.
  const bareUserProps: AuthProps = {
    type: 'user_token',
    accessToken: 'test-token',
    user: { id: 'u1', email: 'test@example.com' },
    accounts: []
  }

  beforeEach(() => seedSpec({}, ['workers'], ALL_TOOLS))
  afterEach(() => {
    vi.unstubAllGlobals()
    return clearSpec()
  })

  function stubFetch(response: () => Promise<Response> | Response) {
    const fetch = vi.fn(async () => response())
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  function stubJson(data: unknown, status = 200) {
    return stubFetch(() => Response.json(data, { status }))
  }

  /** The URL and init of the one Cloudflare API request a call made. */
  function sent(fetch: ReturnType<typeof stubFetch>): { url: URL; init: RequestInit } {
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    return { url: new URL(url), init }
  }

  function headers(init: RequestInit): Record<string, string> {
    return init.headers as Record<string, string>
  }

  it('serves mcp-tools.json without registering per-endpoint SDK handlers', async () => {
    const tools = Array.from({ length: 3_000 }, (_, index) =>
      directTool({
        name: `resource_${index}_get`,
        path: `/accounts/{account_id}/resources/${index}`
      })
    )
    await seedSpec({}, ['workers'], tools)

    const server = await createServer(acctProps('test-account'), { codemode: false })

    // CPU guard: never one SDK handler or schema per endpoint at server creation.
    expect(Object.keys((server as any)._registeredTools)).toEqual([])
    expect(await listTools(server)).toHaveLength(3_002) // docs + whoami + 3,000 endpoint tools
  })

  it('lists the generated protocol fields exactly, and no routing metadata', async () => {
    const server = await createServer(acctProps('test-account'), { codemode: false })

    const tools = JSON.parse(JSON.stringify(await listTools(server)))
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual([
      'docs',
      'whoami',
      ...ALL_TOOLS.map((tool) => tool.name)
    ])
    expect(tools[2]).toEqual({
      name: WORKERS_LIST.name,
      title: WORKERS_LIST.title,
      description: WORKERS_LIST.description,
      inputSchema: WORKERS_LIST.inputSchema,
      annotations: WORKERS_LIST.annotations
    })
    expect(JSON.stringify(tools)).not.toContain('"request"')
    expect(JSON.stringify(tools)).not.toContain('"permissions"')
  })

  it('registers docs with the Cloudflare docs server description and output schema', async () => {
    const server = await createServer(acctProps('test-account'))

    const docsTool = (server as any)._registeredTools['docs']
    expect(docsTool.description).toContain(
      'This tool should be used to answer any question about Cloudflare products or features'
    )
    expect(docsTool.outputSchema).toBeDefined()
  })

  it('fails clearly when mcp-tools.json has not been built', async () => {
    await clearSpec()

    await expect(createServer(acctProps('test-account'), { codemode: false })).rejects.toThrow(
      'mcp-tools.json not found in R2'
    )
  })

  it('registers codemode tools when codemode=true (default)', async () => {
    const server = await createServer(acctProps('test-account'))

    const toolNames = Object.keys((server as any)._registeredTools)
    expect(toolNames).toEqual(['docs', 'search', 'execute', 'whoami'])
  })

  it('calls the Cloudflare API with the session token', async () => {
    const fetch = stubJson({ success: true, result: [{ id: 'my-worker' }] })
    const server = await createServer(acctProps('acct-123'), { codemode: false })

    const result = await callTool(server, 'workers_scripts_list', { account_id: 'acct-123' })

    const { url, init } = sent(fetch)
    expect(url.href).toBe('https://api.cloudflare.com/client/v4/accounts/acct-123/workers/scripts')
    expect(init.method).toBe('GET')
    expect(headers(init)['Authorization']).toBe('Bearer test-token')
    expect(headers(init)['User-Agent']).toBe('cloudflare-mcp')
    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('my-worker')
  })

  it('reports an unknown tool', async () => {
    const server = await createServer(acctProps('acct-1'), { codemode: false })

    const result = await callTool(server, 'get_accounts_workers_scripts', {})

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Tool get_accounts_workers_scripts not found' }]
    })
  })

  it.each([
    [{}, 'zone_id, record_id'],
    [{ zone_id: 'z1' }, 'record_id']
  ])('rejects missing required arguments %j without calling the API', async (args, missing) => {
    const fetch = stubJson({})
    const server = await createServer(bareUserProps, { codemode: false })

    const result = await callTool(server, 'dns_records_delete', args)

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe(
      `Input validation error: Invalid arguments for tool dns_records_delete: missing required ${missing}`
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('serializes query parameters and omits ones not passed', async () => {
    const fetch = stubJson({ success: true, result: [] })
    const server = await createServer(acctProps('acct-1'), { codemode: false })

    await callTool(server, 'workers_scripts_list', { page: 3, tags: ['a', 'b'] })

    const { url } = sent(fetch)
    expect([...url.searchParams]).toEqual([
      ['page', '3'],
      ['tags', 'a'],
      ['tags', 'b']
    ])
  })

  it('sends a nested JSON body as JSON', async () => {
    const fetch = stubJson({ success: true, result: { id: 'new-db' } })
    const server = await createServer(acctProps('acct-1'), { codemode: false })

    await callTool(server, 'd1_database_create', {
      body: { name: 'my-database', options: { jurisdiction: 'eu' } }
    })

    const { init } = sent(fetch)
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"name":"my-database","options":{"jurisdiction":"eu"}}')
    expect(headers(init)['Content-Type']).toBe('application/json')
  })

  it('passes an already-serialized JSON body through unchanged', async () => {
    const fetch = stubJson({ success: true, result: {} })
    const server = await createServer(acctProps('acct-1'), { codemode: false })

    await callTool(server, 'd1_database_create', { body: '{"name":"test"}' })

    expect(sent(fetch).init.body).toBe('{"name":"test"}')
  })

  it('uses the selected content_type for the body', async () => {
    const fetch = stubJson({ success: true, result: {} })
    const server = await createServer(acctProps('acct-1'), { codemode: false })
    const script = 'export default { async fetch() { return new Response("hi"); } }'

    await callTool(server, 'workers_scripts_update', {
      script_name: 'my-worker',
      body: script,
      content_type: 'application/javascript'
    })

    const { init } = sent(fetch)
    expect(headers(init)['Content-Type']).toBe('application/javascript')
    expect(init.body).toBe(script)
  })

  it('encodes multipart and form bodies from objects', async () => {
    const fetch = stubJson({ success: true, result: {} })
    const server = await createServer(acctProps('acct-1'), { codemode: false })

    await callTool(server, 'tokens_form', {
      body: { name: 'n', scopes: ['a', 'b'] },
      content_type: 'multipart/form-data'
    })
    await callTool(server, 'tokens_form', { body: { name: 'n', ttl: 60 } })

    const [multipart, urlencoded] = fetch.mock.calls.map(
      (call) => (call as unknown as [string, RequestInit])[1]
    )
    const form = multipart!.body as FormData
    expect(form.getAll('scopes')).toEqual(['a', 'b'])
    expect(form.get('name')).toBe('n')
    // FormData supplies its own multipart boundary.
    expect(headers(multipart!)['Content-Type']).toBeUndefined()
    expect(urlencoded!.body).toBe('name=n&ttl=60')
    expect(headers(urlencoded!)['Content-Type']).toBe('application/x-www-form-urlencoded')
  })

  it('sends no body or Content-Type when no body is passed', async () => {
    const fetch = stubJson({ success: true, result: [] })
    const server = await createServer(acctProps('acct-1'), { codemode: false })

    await callTool(server, 'workers_scripts_list', {})

    const { init } = sent(fetch)
    expect(headers(init)['Content-Type']).toBeUndefined()
    expect(init.body).toBeUndefined()
  })

  it('sends header parameters under their wire names, only when passed', async () => {
    const fetch = stubJson({ success: true, result: {} })
    const server = await createServer(acctProps('acct-1'), { codemode: false })

    await callTool(server, 'workers_scripts_update', {
      script_name: 'my-worker',
      header_if_match: '"etag-123"'
    })
    await callTool(server, 'workers_scripts_update', { script_name: 'my-worker' })

    const [withHeader, without] = fetch.mock.calls.map(
      (call) => (call as unknown as [string, RequestInit])[1]
    )
    expect(headers(withHeader!)['If-Match']).toBe('"etag-123"')
    expect(headers(without!)['If-Match']).toBeUndefined()
  })

  it('returns non-JSON responses as text', async () => {
    stubFetch(
      () => new Response('raw-kv-value-here', { headers: { 'content-type': 'text/plain' } })
    )
    const server = await createServer(acctProps('acct-1'), { codemode: false })

    const result = await callTool(server, 'kv_namespaces_values_get', {
      namespace_id: 'ns-1',
      key_name: 'mykey'
    })

    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toBe('raw-kv-value-here')
  })

  it('sets isError for API errors and names the account when it is unknown', async () => {
    stubJson({ success: false, errors: [{ code: 10000, message: 'Auth error' }] }, 403)
    const server = await createServer(acctProps('acct-1'), { codemode: false })

    const result = await callTool(server, 'workers_scripts_list', { account_id: 'other' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Auth error')
    expect(result.content[0].text).toContain('acct-1')
  })

  it('returns network failures as tool errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')))
    const server = await createServer(acctProps('acct-1'), { codemode: false })

    const result = await callTool(server, 'workers_scripts_list', {})

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Network failure')
  })

  it('encodes path parameters', async () => {
    const fetch = stubJson({ success: true, result: {} })
    const server = await createServer(acctProps('acct-1'), { codemode: false })

    await callTool(server, 'workers_scripts_get', { script_name: 'my worker/v2' })

    expect(sent(fetch).url.pathname).toBe(
      '/client/v4/accounts/acct-1/workers/scripts/my%20worker%2Fv2'
    )
  })

  it("lists the session's accounts when multi-account account_id is missing", async () => {
    const fetch = stubJson({})
    const props: AuthProps = {
      type: 'user_token',
      accessToken: 'test-token',
      user: { id: 'u1', email: 'test@example.com' },
      accounts: [
        { id: 'acct-1', name: 'Account One' },
        { id: 'acct-2', name: 'Account Two' }
      ]
    }
    const server = await createServer(props, { codemode: false })

    const result = await callTool(server, 'workers_scripts_list', {})

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe(
      "No account selected. Pass account_id with one of this session's accounts:\n- acct-1 (Account One)\n- acct-2 (Account Two)"
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('calls endpoints without parameters', async () => {
    stubJson({ success: true, result: { id: 'u1', email: 'a@b.com' } })
    const server = await createServer(bareUserProps, { codemode: false })

    const result = await callTool(server, 'user_get', {})

    expect(result.isError).toBeFalsy()
    expect(result.content[0].text).toContain('a@b.com')
  })

  it('sends path, query and body together', async () => {
    const fetch = stubJson({ success: true, result: {} })
    const server = await createServer(bareUserProps, { codemode: false })

    await callTool(server, 'dns_records_edit', {
      zone_id: 'z1',
      record_id: 'r1',
      comment: 'updated IP',
      body: { content: '1.2.3.4' }
    })

    const { url, init } = sent(fetch)
    expect(url.pathname).toBe('/client/v4/zones/z1/dns_records/r1')
    expect(url.search).toBe('?comment=updated+IP')
    expect(init.method).toBe('PATCH')
    expect(init.body).toBe('{"content":"1.2.3.4"}')
  })
})

describe('tool metadata is identical for every user', () => {
  afterEach(() => clearSpec())

  function singleAccountUser(id: string, name: string, email: string): AuthProps {
    return {
      type: 'user_token',
      accessToken: `token-${id}`,
      user: { id: `user-${id}`, email },
      accounts: [{ id, name }]
    }
  }

  function multiAccountUser(prefix: string, email: string): AuthProps {
    return {
      type: 'user_token',
      accessToken: `token-${prefix}`,
      user: { id: `user-${prefix}`, email },
      accounts: [
        { id: `${prefix}-one`, name: `${prefix} One` },
        { id: `${prefix}-two`, name: `${prefix} Two` }
      ],
      version: AUTH_PROPS_VERSION
    }
  }

  function accountToken(id: string, name: string): AuthProps {
    return {
      type: 'account_token',
      accessToken: `token-${id}`,
      account: { id, name }
    }
  }

  async function serializedTools(props: AuthProps, codemode: boolean): Promise<string> {
    return JSON.stringify(await listTools(await createServer(props, { codemode })))
  }

  function userWithAccounts(
    count: number,
    extra: Partial<Extract<AuthProps, { type: 'user_token' }>> = {}
  ): AuthProps {
    return {
      type: 'user_token',
      accessToken: `token-${count}`,
      user: { id: `user-${count}`, email: `user${count}@example.com` },
      accounts: Array.from({ length: count }, (_, index) => ({
        id: `acct-${count}-${index + 1}`,
        name: `Account ${count}-${index + 1}`
      })),
      ...extra
    }
  }

  const alice = singleAccountUser('aaaa1111', "alice@example.com's Account", 'alice@example.com')

  // Every token shape the server distinguishes at call time. A client may cache
  // the tool list from any one of them and serve it to any other.
  const sessions: Array<[string, AuthProps]> = [
    [
      'another single-account user',
      singleAccountUser('bbbb2222', "bob's Account", 'bob@example.com')
    ],
    ['a versioned multi-account user', multiAccountUser('carol', 'carol@example.com')],
    ['a 30-account user', userWithAccounts(30)],
    ['a legacy grant with exactly 20 accounts', userWithAccounts(20)],
    [
      'a versioned grant with exactly 20 accounts',
      userWithAccounts(20, { version: AUTH_PROPS_VERSION })
    ],
    ['a user whose account list was omitted', userWithAccounts(0, { accountCount: 137 })],
    ['an account token', accountToken('dddd4444', 'Dave LLC')]
  ]

  for (const codemode of [true, false]) {
    for (const [label, session] of sessions) {
      it(`matches a single-account user for ${label} with codemode=${codemode}`, async () => {
        await seedSpec(
          {
            '/accounts/{account_id}/workers/scripts': {
              get: { summary: 'List Workers' } as OperationInfo
            }
          },
          ['workers'],
          [WORKERS_LIST]
        )
        expect(await serializedTools(session, codemode)).toBe(
          await serializedTools(alice, codemode)
        )
      })
    }
  }

  it('never includes the account id, account name, or email of a single-account user', async () => {
    await seedSpec({})
    const tools = await serializedTools(alice, true)
    expect(tools).toContain('GET /accounts')
    expect(tools).not.toContain('aaaa1111')
    expect(tools).not.toContain('alice@example.com')
  })
})

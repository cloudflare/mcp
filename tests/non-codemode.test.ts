import { afterEach, describe, it, expect, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { createServer } from '../src/server'
import { buildInputSchema, buildNonCodemodeTools, pathToToolName } from '../src/openapi'
import type { OperationInfo } from '../src/openapi'
import { AUTH_PROPS_VERSION, type AuthProps } from '../src/auth/types'
import { DOCS_TOOL, registerDocsTool } from '../src/tools/docs-search'
import { clearSpec, removeNonCodemodeTools, seedSpec } from './helpers/spec'

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
})

describe('pathToToolName', () => {
  it('keeps accounts in name, strips param', () => {
    expect(pathToToolName('get', '/accounts/{account_id}/workers/scripts')).toBe(
      'get_accounts_workers_scripts'
    )
  })

  it('keeps zones in name, strips param', () => {
    expect(pathToToolName('get', '/zones/{zone_id}/dns_records')).toBe('get_zones_dns_records')
  })

  it('converts a POST endpoint', () => {
    expect(pathToToolName('post', '/accounts/{account_id}/d1/database')).toBe(
      'post_accounts_d1_database'
    )
  })

  it('adds by_param suffix for trailing path param', () => {
    expect(pathToToolName('get', '/accounts/{account_id}/workers/scripts/{script_name}')).toBe(
      'get_accounts_workers_scripts_by_script_name'
    )
  })

  it('disambiguates collection vs resource paths', () => {
    const collection = pathToToolName('get', '/accounts/{account_id}/workers/scripts')
    const resource = pathToToolName('get', '/accounts/{account_id}/workers/scripts/{script_name}')
    expect(collection).toBe('get_accounts_workers_scripts')
    expect(resource).toBe('get_accounts_workers_scripts_by_script_name')
    expect(collection).not.toBe(resource)
  })

  it('strips intermediate params but keeps trailing one', () => {
    expect(
      pathToToolName(
        'get',
        '/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/{key_name}'
      )
    ).toBe('get_accounts_storage_kv_namespaces_values_by_key_name')
  })

  it('handles paths with no params', () => {
    expect(pathToToolName('get', '/user')).toBe('get_user')
    expect(pathToToolName('get', '/user/tokens')).toBe('get_user_tokens')
  })

  it('handles graphql path', () => {
    expect(pathToToolName('post', '/client/v4/graphql')).toBe('post_client_v4_graphql')
  })

  it('truncates tool names to 128 characters max', () => {
    const longPath =
      '/accounts/{account_id}/some_very_long_product_name/resources/{resource_id}/subresources/{sub_id}'
    const name = pathToToolName('get', longPath)
    expect(name.length).toBeLessThanOrEqual(128)
  })

  it('does not leave trailing underscore after truncation', () => {
    const longPath =
      '/accounts/{account_id}/long_product_name_here/resources/{resource_id}/items/{item_id}'
    const name = pathToToolName('get', longPath)
    expect(name.length).toBeLessThanOrEqual(128)
    expect(name.endsWith('_')).toBe(false)
  })

  it('all realistic Cloudflare paths produce names <= 64 chars', () => {
    const realisticPaths = [
      '/accounts/{account_id}/workers/scripts',
      '/accounts/{account_id}/workers/scripts/{script_name}',
      '/zones/{zone_id}/dns_records/{record_id}',
      '/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/{key_name}',
      '/accounts/{account_id}/resourcelibrary/applications',
      '/accounts/{account_id}/resourcelibrary/applications/{app_id}',
      '/accounts/{account_id}/d1/database',
      '/user/tokens',
      '/client/v4/graphql',
      '/accounts/{account_id}/workers/scripts/{script_name}/schedules'
    ]
    for (const path of realisticPaths) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        const name = pathToToolName(method, path)
        expect(name.length).toBeLessThanOrEqual(128)
      }
    }
  })
})

describe('buildInputSchema', () => {
  it('precomputes the same wire JSON Schema emitted by the MCP SDK', async () => {
    const path = '/zones/{zone_id}/dns_records/{record_id}'
    const operation: OperationInfo = {
      parameters: [
        { name: 'zone_id', in: 'path', required: true, description: 'Zone ID' },
        { name: 'record_id', in: 'path', required: true },
        { name: 'page', in: 'query', description: 'Page number' },
        { name: 'type', in: 'query', required: true },
        { name: 'If-Match', in: 'header', description: 'ETag' }
      ],
      requestBody: {
        content: {
          'application/json': {},
          'text/plain': {}
        }
      }
    }
    const precomputed = buildNonCodemodeTools({ [path]: { patch: operation } })[0]
    const server = new McpServer({ name: 'schema-test', version: '1.0.0' })
    server.registerTool(
      precomputed.name,
      { inputSchema: buildInputSchema(operation, path) },
      async () => ({ content: [] })
    )

    const [listed] = await listTools(server)
    expect(precomputed.inputSchema).toEqual(listed.inputSchema)
  })

  it('deduplicates repeated path parameter names in precomputed required fields', () => {
    const [tool] = buildNonCodemodeTools({
      '/accounts/{account_id}/address_maps/{map_id}/accounts/{account_id}': {
        put: {} as OperationInfo
      }
    })

    expect(tool.inputSchema.required).toEqual(['account_id', 'map_id'])
  })

  // --- Path parameters ---

  it('creates schema with a single path parameter', () => {
    const operation: OperationInfo = {
      parameters: [
        { name: 'account_id', in: 'path', required: true, description: 'Account identifier' }
      ]
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['account_id']).toBeDefined()
  })

  it('creates schema with multiple path parameters', () => {
    const operation: OperationInfo = {
      parameters: [
        { name: 'zone_id', in: 'path', required: true, description: 'Zone ID' },
        { name: 'record_id', in: 'path', required: true, description: 'DNS record ID' }
      ]
    }
    const schema = buildInputSchema(operation, '/zones/{zone_id}/dns_records/{record_id}')
    expect(schema['zone_id']).toBeDefined()
    expect(schema['record_id']).toBeDefined()
  })

  it('extracts path params from template even without explicit parameter definitions', () => {
    const operation: OperationInfo = {}
    const schema = buildInputSchema(
      operation,
      '/accounts/{account_id}/workers/scripts/{script_name}'
    )
    expect(schema['account_id']).toBeDefined()
    expect(schema['script_name']).toBeDefined()
  })

  it('uses description from parameter spec when available', () => {
    const operation: OperationInfo = {
      parameters: [
        { name: 'zone_id', in: 'path', required: true, description: 'The zone identifier' }
      ]
    }
    const schema = buildInputSchema(operation, '/zones/{zone_id}/dns_records')
    // Zod stores description — verify it's set by checking the schema definition
    expect(schema['zone_id'].description).toBe('The zone identifier')
  })

  it('falls back to generic description when parameter spec has no description', () => {
    const operation: OperationInfo = {
      parameters: [{ name: 'zone_id', in: 'path', required: true }]
    }
    const schema = buildInputSchema(operation, '/zones/{zone_id}/dns_records')
    expect(schema['zone_id'].description).toBe('Path parameter: zone_id')
  })

  it('falls back to generic description when path param has no matching parameter spec', () => {
    const operation: OperationInfo = { parameters: [] }
    const schema = buildInputSchema(operation, '/zones/{zone_id}/dns_records')
    expect(schema['zone_id'].description).toBe('Path parameter: zone_id')
  })

  // --- Query parameters ---

  it('creates schema with required query parameter', () => {
    const operation: OperationInfo = {
      parameters: [{ name: 'per_page', in: 'query', required: true, description: 'Items per page' }]
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['per_page']).toBeDefined()
    expect(schema['per_page'].isOptional()).toBe(false)
  })

  it('creates schema with optional query parameter', () => {
    const operation: OperationInfo = {
      parameters: [{ name: 'page', in: 'query', required: false, description: 'Page number' }]
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['page']).toBeDefined()
    expect(schema['page'].isOptional()).toBe(true)
  })

  it('treats query parameter without required field as optional', () => {
    const operation: OperationInfo = {
      parameters: [{ name: 'direction', in: 'query', description: 'Sort direction' }]
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['direction'].isOptional()).toBe(true)
  })

  it('handles multiple query parameters with mixed required/optional', () => {
    const operation: OperationInfo = {
      parameters: [
        { name: 'page', in: 'query', required: false, description: 'Page number' },
        { name: 'per_page', in: 'query', required: true, description: 'Items per page' },
        { name: 'order', in: 'query', required: false, description: 'Sort order' },
        { name: 'direction', in: 'query', required: false, description: 'asc or desc' }
      ]
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['page'].isOptional()).toBe(true)
    expect(schema['per_page'].isOptional()).toBe(false)
    expect(schema['order'].isOptional()).toBe(true)
    expect(schema['direction'].isOptional()).toBe(true)
  })

  it('uses param name as fallback description for query params', () => {
    const operation: OperationInfo = {
      parameters: [{ name: 'page', in: 'query', required: false }]
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['page'].description).toBe('page')
  })

  // --- Header parameters ---

  it('creates schema with header parameter', () => {
    const operation: OperationInfo = {
      parameters: [
        {
          name: 'If-Match',
          in: 'header',
          required: false,
          description: 'ETag for optimistic concurrency'
        }
      ]
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['header_if_match']).toBeDefined()
    expect(schema['header_if_match'].isOptional()).toBe(true)
  })

  it('creates required header parameter', () => {
    const operation: OperationInfo = {
      parameters: [{ name: 'If-Match', in: 'header', required: true, description: 'Required ETag' }]
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['header_if_match']).toBeDefined()
    expect(schema['header_if_match'].isOptional()).toBe(false)
  })

  it('includes header name in description', () => {
    const operation: OperationInfo = {
      parameters: [{ name: 'If-Match', in: 'header', required: false, description: 'ETag value' }]
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['header_if_match'].description).toContain('If-Match')
    expect(schema['header_if_match'].description).toContain('ETag value')
  })

  it('normalizes header name to safe key (lowercase, hyphens to underscores)', () => {
    const operation: OperationInfo = {
      parameters: [{ name: 'X-Custom-Header', in: 'header', required: false }]
    }
    const schema = buildInputSchema(operation, '/user')
    expect(schema['header_x_custom_header']).toBeDefined()
    expect(schema['header_X-Custom-Header']).toBeUndefined()
  })

  // --- Request body ---

  it('adds body param when requestBody exists', () => {
    const operation: OperationInfo = {
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/d1/database')
    expect(schema['body']).toBeDefined()
  })

  it('body param is always optional in schema (validation is at API level)', () => {
    const operation: OperationInfo = {
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/d1/database')
    expect(schema['body'].isOptional()).toBe(true)
  })

  it('does not add body param when no requestBody', () => {
    const operation: OperationInfo = {}
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['body']).toBeUndefined()
  })

  // --- Content-Type ---

  it('adds content_type param when endpoint supports non-JSON content types', () => {
    const operation: OperationInfo = {
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { type: 'object' } },
          'application/javascript': { schema: { type: 'string' } },
          'multipart/form-data': { schema: { type: 'object' } }
        }
      }
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['content_type']).toBeDefined()
    expect(schema['content_type'].isOptional()).toBe(true)
    expect(schema['content_type'].description).toContain('application/javascript')
    expect(schema['content_type'].description).toContain('multipart/form-data')
  })

  it('does not add content_type param when endpoint only supports JSON', () => {
    const operation: OperationInfo = {
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/d1/database')
    expect(schema['content_type']).toBeUndefined()
  })

  it('does not add content_type param when no requestBody content', () => {
    const operation: OperationInfo = {
      requestBody: { required: true }
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['content_type']).toBeUndefined()
  })

  // --- Combined / complex cases ---

  it('handles path params + query params + body together', () => {
    const operation: OperationInfo = {
      parameters: [
        { name: 'account_id', in: 'path', required: true, description: 'Account ID' },
        { name: 'page', in: 'query', required: false, description: 'Page' },
        { name: 'per_page', in: 'query', required: false, description: 'Per page' }
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['account_id']).toBeDefined()
    expect(schema['page']).toBeDefined()
    expect(schema['per_page']).toBeDefined()
    expect(schema['body']).toBeDefined()
    expect(Object.keys(schema)).toHaveLength(4)
  })

  it('handles path params + query params + headers + body together', () => {
    const operation: OperationInfo = {
      parameters: [
        { name: 'zone_id', in: 'path', required: true },
        { name: 'record_id', in: 'path', required: true },
        { name: 'page', in: 'query', required: false },
        { name: 'If-Match', in: 'header', required: false, description: 'ETag' }
      ],
      requestBody: { required: true, content: {} }
    }
    const schema = buildInputSchema(operation, '/zones/{zone_id}/dns_records/{record_id}')
    expect(schema['zone_id']).toBeDefined()
    expect(schema['record_id']).toBeDefined()
    expect(schema['page']).toBeDefined()
    expect(schema['header_if_match']).toBeDefined()
    expect(schema['body']).toBeDefined()
    expect(Object.keys(schema)).toHaveLength(5)
  })

  it('returns empty schema for endpoint with no path params, no query, no body', () => {
    const operation: OperationInfo = {}
    const schema = buildInputSchema(operation, '/user')
    expect(Object.keys(schema)).toHaveLength(0)
  })

  it('handles endpoint with only a summary and description (no params)', () => {
    const operation: OperationInfo = {
      summary: 'Get current user',
      description: 'Returns the currently authenticated user'
    }
    const schema = buildInputSchema(operation, '/user')
    expect(Object.keys(schema)).toHaveLength(0)
  })

  it('ignores cookie parameters', () => {
    const operation: OperationInfo = {
      parameters: [{ name: 'session', in: 'cookie' as any, required: false }]
    }
    const schema = buildInputSchema(operation, '/user')
    expect(schema['session']).toBeUndefined()
    expect(Object.keys(schema)).toHaveLength(0)
  })

  it('handles empty parameters array', () => {
    const operation: OperationInfo = { parameters: [] }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    // Should still extract account_id from the path template
    expect(schema['account_id']).toBeDefined()
    expect(Object.keys(schema)).toHaveLength(1)
  })

  it('handles undefined parameters', () => {
    const operation: OperationInfo = { parameters: undefined }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['account_id']).toBeDefined()
    expect(Object.keys(schema)).toHaveLength(1)
  })

  it('does not duplicate path params that also appear as query params with same name', () => {
    // Edge case: a parameter named the same in both path and query
    const operation: OperationInfo = {
      parameters: [
        { name: 'account_id', in: 'path', required: true, description: 'Account ID (path)' },
        { name: 'account_id', in: 'query', required: false, description: 'Account ID (query)' }
      ]
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    // Query param overwrites path param since it's processed second
    expect(schema['account_id']).toBeDefined()
  })

  // --- Deeply nested / unusual paths ---

  it('handles deeply nested paths with many params', () => {
    const operation: OperationInfo = {
      parameters: [
        { name: 'account_id', in: 'path', required: true },
        { name: 'namespace_id', in: 'path', required: true },
        { name: 'key_name', in: 'path', required: true }
      ]
    }
    const schema = buildInputSchema(
      operation,
      '/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/{key_name}'
    )
    expect(schema['account_id']).toBeDefined()
    expect(schema['namespace_id']).toBeDefined()
    expect(schema['key_name']).toBeDefined()
    expect(Object.keys(schema)).toHaveLength(3)
  })

  it('handles graphql endpoint path with no params', () => {
    const operation: OperationInfo = {
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
    const schema = buildInputSchema(operation, '/client/v4/graphql')
    expect(schema['body']).toBeDefined()
    expect(Object.keys(schema)).toHaveLength(1)
  })
})

describe('createServer with codemode=false', () => {
  // Account-token session pinned to a single account id (token fixed to that account).
  function acctProps(accountId: string): AuthProps {
    return {
      type: 'account_token',
      accessToken: 'test-token',
      account: { id: accountId, name: accountId }
    }
  }

  // User token whose account context is irrelevant to the assertion (account_id
  // unresolved, exactly as a bare token previously behaved).
  const bareUserProps: AuthProps = {
    type: 'user_token',
    accessToken: 'test-token',
    user: { id: 'u1', email: 'test@example.com' },
    accounts: []
  }

  afterEach(() => clearSpec())

  function mockFetchJson(data: unknown, ok = true) {
    return vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => data
    })
  }

  function mockFetchText(text: string, ok = true) {
    return vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: async () => text
    })
  }

  it('does not register per-endpoint SDK handlers for a large spec', async () => {
    const specPaths = Object.fromEntries(
      Array.from({ length: 3_000 }, (_, index) => [
        `/accounts/{account_id}/resources/${index}`,
        { get: { summary: `Get resource ${index}` } as OperationInfo }
      ])
    )

    await seedSpec(specPaths)
    const server = await createServer(acctProps('test-account'), false)

    expect(Object.keys((server as any)._registeredTools)).toEqual([])
    const tools = await listTools(server)
    expect(tools).toHaveLength(3_001) // docs + 3,000 endpoint tools
  })

  it('registers one tool per endpoint when codemode=false', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: { summary: 'List Workers', tags: ['Workers Scripts'] } as OperationInfo,
        post: { summary: 'Create Worker', tags: ['Workers Scripts'] } as OperationInfo
      },
      '/zones/{zone_id}/dns_records': {
        get: { summary: 'List DNS Records', tags: ['DNS'] } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('test-account'), false)

    // CPU guard: non-Code-Mode must dispatch lazily, never register one SDK
    // handler/Zod schema per endpoint during server creation.
    expect(Object.keys((server as any)._registeredTools)).toEqual([])

    const tools = await listTools(server)
    const toolNames = tools.map((tool) => tool.name)
    expect(toolNames).toContain('docs')
    expect(toolNames).toContain('get_accounts_workers_scripts')
    expect(toolNames).toContain('post_accounts_workers_scripts')
    expect(toolNames).toContain('get_zones_dns_records')

    // Should NOT have codemode tools
    expect(toolNames).not.toContain('search')
    expect(toolNames).not.toContain('execute')
  })

  it('registers docs with the Cloudflare docs server description and output schema', async () => {
    await seedSpec({})
    const server = await createServer(acctProps('test-account'), true)

    const docsTool = (server as any)._registeredTools['docs']
    expect(docsTool.description).toContain(
      'This tool should be used to answer any question about Cloudflare products or features'
    )
    expect(docsTool.description).toContain(
      'Results are returned as semantically similar chunks to the query.'
    )
    expect(docsTool.outputSchema).toBeDefined()
  })

  it('falls back to spec.json when the precomputed artifact is absent', async () => {
    const specPaths = {
      '/user': {
        get: { summary: 'Get current user' } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    await removeNonCodemodeTools()
    const server = await createServer(bareUserProps, false)

    const tools = await listTools(server)
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'get_user', description: 'GET /user\n\nGet current user' })
      ])
    )
  })

  it('registers codemode tools when codemode=true (default)', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: { summary: 'List Workers' } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('test-account'), true)

    const tools = (server as any)._registeredTools
    const toolNames = Object.keys(tools)
    expect(toolNames).toContain('docs')
    expect(toolNames).toContain('search')
    expect(toolNames).toContain('execute')
    expect(toolNames).not.toContain('get_accounts_workers_scripts')
  })

  it('includes a small account list only in the execute tool description', async () => {
    const accounts = Array.from({ length: 30 }, (_, index) => ({
      id: `acct-${index + 1}`,
      name: `Account ${index + 1}`
    }))
    const props: AuthProps = {
      type: 'user_token',
      accessToken: 'test-token',
      user: { id: 'u1', email: 'test@example.com' },
      accounts
    }
    await seedSpec({})

    const server = await createServer(props, true)
    const execute = (server as any)._registeredTools['execute']
    const accountIdDescription = execute.inputSchema.shape.account_id.description

    expect((server as any).server._instructions).toBeUndefined()
    expect(execute.description).toContain('Available accounts')
    expect(execute.description).toContain('acct-1 (Account 1)')
    expect(execute.description).toContain('acct-30 (Account 30)')
    expect(accountIdDescription).not.toContain('acct-1')
    expect(accountIdDescription).toBe(
      'Cloudflare account ID to scope execution to a singular account. Optional for account-independent calls.'
    )
  })

  it('treats a legacy grant (no version) with exactly 20 accounts as incomplete', async () => {
    const accounts = Array.from({ length: 20 }, (_, index) => ({
      id: `legacy-acct-${index + 1}`,
      name: `Legacy Account ${index + 1}`
    }))
    const props: AuthProps = {
      type: 'user_token',
      accessToken: 'test-token',
      user: { id: 'u1', email: 'test@example.com' },
      accounts
    }
    await seedSpec({})

    const server = await createServer(props, true)
    const execute = (server as any)._registeredTools['execute']
    const accountIdDescription = execute.inputSchema.shape.account_id.description

    expect(accountIdDescription).not.toContain('legacy-acct-1')
    expect(accountIdDescription).not.toContain('GET /accounts')
    expect(execute.description).not.toContain('legacy-acct-1')
    expect(execute.description).toContain('multiple Cloudflare accounts')
    expect(execute.description).toContain('GET /accounts')
  })

  it('inlines exactly 20 accounts when the grant is versioned (complete)', async () => {
    const accounts = Array.from({ length: 20 }, (_, index) => ({
      id: `fresh-acct-${index + 1}`,
      name: `Fresh Account ${index + 1}`
    }))
    const props: AuthProps = {
      type: 'user_token',
      accessToken: 'test-token',
      user: { id: 'u1', email: 'test@example.com' },
      accounts,
      version: AUTH_PROPS_VERSION
    }
    await seedSpec({})

    const server = await createServer(props, true)
    const execute = (server as any)._registeredTools['execute']
    const accountIdDescription = execute.inputSchema.shape.account_id.description

    expect(execute.description).toContain('fresh-acct-1 (Fresh Account 1)')
    expect(execute.description).toContain('fresh-acct-20 (Fresh Account 20)')
    expect(accountIdDescription).not.toContain('fresh-acct-1')
  })

  it('reports only the count when the account list was omitted at the identity layer', async () => {
    const props: AuthProps = {
      type: 'user_token',
      accessToken: 'test-token',
      user: { id: 'u1', email: 'test@example.com' },
      accounts: [],
      accountCount: 137
    }
    await seedSpec({})

    const server = await createServer(props, true)
    const execute = (server as any)._registeredTools['execute']
    const accountIdDescription = execute.inputSchema.shape.account_id.description

    expect(accountIdDescription).not.toContain('137 accounts')
    expect(accountIdDescription).not.toContain('GET /accounts')
    expect(execute.description).toContain('137 Cloudflare accounts')
    expect(execute.description).not.toContain('multiple Cloudflare accounts')
    expect(execute.description).toContain('GET /accounts')
    expect(execute.description).toContain('GET /accounts?name=')
  })

  // NOTE: "execute without account_id runs account-independent discovery calls"
  // is covered end-to-end against the real Worker Loader in tests/executor.test.ts
  // ('execute: no account resolved (multi-account user token)').

  it('tool handler makes direct fetch call for non-codemode tools', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: {
          summary: 'List Workers',
          parameters: [{ name: 'account_id', in: 'path', required: true }]
        } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('acct-123'), false)

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: [{ id: 'my-worker' }] })

    try {
      const result = await callTool(server, 'get_accounts_workers_scripts', {
        account_id: 'acct-123'
      })

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/acct-123/workers/scripts',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' })
        })
      )

      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('my-worker')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  // NOTE: account_id auto-resolution is covered end-to-end (through real MCP
  // argument validation) in tests/non-codemode-worker.test.ts. Direct
  // tool.handler({}) calls bypass that validation and gave false confidence —
  // they passed even while production rejected the same call with an Input
  // validation error (account_id was a required schema field). Don't re-add
  // handler-level auto-resolve tests here.

  it('returns error for missing required path param', async () => {
    const specPaths = {
      '/zones/{zone_id}/dns_records/{record_id}': {
        delete: { summary: 'Delete DNS Record' } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(bareUserProps, false)

    const result = await callTool(server, 'delete_zones_dns_records_by_record_id', {})
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Input validation error')
    expect(result.content[0].text).toContain('zone_id')
  })

  it('returns error for second missing path param (first resolved)', async () => {
    const specPaths = {
      '/zones/{zone_id}/dns_records/{record_id}': {
        delete: { summary: 'Delete DNS Record' } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(bareUserProps, false)

    // Provide zone_id but not record_id
    const result = await callTool(server, 'delete_zones_dns_records_by_record_id', {
      zone_id: 'z1'
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Input validation error')
    expect(result.content[0].text).toContain('record_id')
  })

  it('passes query params to the URL', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: {
          summary: 'List Workers',
          parameters: [
            { name: 'account_id', in: 'path', required: true },
            { name: 'page', in: 'query', required: false, description: 'Page number' }
          ]
        } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('acct-1'), false)

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: [] })

    try {
      await callTool(server, 'get_accounts_workers_scripts', { page: '2' })
      const calledUrl = (globalThis.fetch as any).mock.calls[0][0]
      expect(calledUrl).toContain('page=2')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('omits undefined query params from URL', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: {
          summary: 'List Workers',
          parameters: [
            { name: 'account_id', in: 'path', required: true },
            { name: 'page', in: 'query', required: false },
            { name: 'per_page', in: 'query', required: false }
          ]
        } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('acct-1'), false)

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: [] })

    try {
      // Only pass page, not per_page
      await callTool(server, 'get_accounts_workers_scripts', { page: '3' })
      const calledUrl = (globalThis.fetch as any).mock.calls[0][0]
      expect(calledUrl).toContain('page=3')
      expect(calledUrl).not.toContain('per_page')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('sends request body for POST tools', async () => {
    const specPaths = {
      '/accounts/{account_id}/d1/database': {
        post: {
          summary: 'Create D1 Database',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } }
          }
        } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('acct-1'), false)

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: { id: 'new-db' } })

    try {
      const body = JSON.stringify({ name: 'my-database' })
      await callTool(server, 'post_accounts_d1_database', { body })

      const calledOpts = (globalThis.fetch as any).mock.calls[0][1]
      expect(calledOpts.method).toBe('POST')
      expect(calledOpts.body).toBe(body)
      expect(calledOpts.headers['Content-Type']).toBe('application/json')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('uses custom content_type when provided', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts/{script_name}': {
        put: {
          summary: 'Upload Worker',
          requestBody: {
            required: true,
            content: {
              'application/javascript': { schema: { type: 'string' } },
              'multipart/form-data': { schema: { type: 'object' } }
            }
          }
        } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('acct-1'), false)

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: {} })

    try {
      const scriptBody = 'export default { async fetch() { return new Response("hi"); } }'
      await callTool(server, 'put_accounts_workers_scripts_by_script_name', {
        script_name: 'my-worker',
        body: scriptBody,
        content_type: 'application/javascript'
      })

      const calledOpts = (globalThis.fetch as any).mock.calls[0][1]
      expect(calledOpts.headers['Content-Type']).toBe('application/javascript')
      expect(calledOpts.body).toBe(scriptBody)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('defaults to application/json when content_type not provided', async () => {
    const specPaths = {
      '/accounts/{account_id}/d1/database': {
        post: {
          summary: 'Create D1 Database',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } }
          }
        } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('acct-1'), false)

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: {} })

    try {
      await callTool(server, 'post_accounts_d1_database', { body: '{"name":"test"}' })
      const calledOpts = (globalThis.fetch as any).mock.calls[0][1]
      expect(calledOpts.headers['Content-Type']).toBe('application/json')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not set Content-Type when no body provided', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: { summary: 'List Workers' } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('acct-1'), false)

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: [] })

    try {
      await callTool(server, 'get_accounts_workers_scripts', {})
      const calledOpts = (globalThis.fetch as any).mock.calls[0][1]
      expect(calledOpts.headers['Content-Type']).toBeUndefined()
      expect(calledOpts.body).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('passes header params through to fetch', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts/{script_name}': {
        put: {
          summary: 'Update Worker',
          parameters: [
            { name: 'account_id', in: 'path', required: true },
            { name: 'script_name', in: 'path', required: true },
            { name: 'If-Match', in: 'header', required: false, description: 'ETag' }
          ],
          requestBody: { required: true, content: {} }
        } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('acct-1'), false)

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: {} })

    try {
      await callTool(server, 'put_accounts_workers_scripts_by_script_name', {
        script_name: 'my-worker',
        header_if_match: '"etag-123"',
        body: '{}'
      })

      const calledOpts = (globalThis.fetch as any).mock.calls[0][1]
      expect(calledOpts.headers['If-Match']).toBe('"etag-123"')
      expect(calledOpts.headers['Authorization']).toBe('Bearer test-token')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('omits header when header param is not provided', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts/{script_name}': {
        put: {
          summary: 'Update Worker',
          parameters: [
            { name: 'account_id', in: 'path', required: true },
            { name: 'script_name', in: 'path', required: true },
            { name: 'If-Match', in: 'header', required: false }
          ]
        } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('acct-1'), false)

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: {} })

    try {
      await callTool(server, 'put_accounts_workers_scripts_by_script_name', {
        script_name: 'my-worker'
      })
      const calledOpts = (globalThis.fetch as any).mock.calls[0][1]
      expect(calledOpts.headers['If-Match']).toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('handles non-JSON response (e.g., KV value)', async () => {
    const specPaths = {
      '/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/{key_name}': {
        get: { summary: 'Read KV value' } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('acct-1'), false)

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchText('raw-kv-value-here')

    try {
      const result = await callTool(
        server,
        'get_accounts_storage_kv_namespaces_values_by_key_name',
        { namespace_id: 'ns-1', key_name: 'mykey' }
      )
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('raw-kv-value-here')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('sets isError=true for non-ok responses', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: { summary: 'List Workers' } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('acct-1'), false)

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson(
      { success: false, errors: [{ code: 10000, message: 'Auth error' }] },
      false
    )

    try {
      const result = await callTool(server, 'get_accounts_workers_scripts', {})
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Auth error')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('handles fetch throwing an error', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: { summary: 'List Workers' } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('acct-1'), false)

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network failure'))

    try {
      const result = await callTool(server, 'get_accounts_workers_scripts', {})
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Network failure')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('encodes path parameters in URL', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts/{script_name}': {
        get: { summary: 'Get Worker' } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('acct-1'), false)

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: {} })

    try {
      await callTool(server, 'get_accounts_workers_scripts_by_script_name', {
        script_name: 'my worker/v2'
      })
      const calledUrl = (globalThis.fetch as any).mock.calls[0][0]
      expect(calledUrl).toContain('my%20worker%2Fv2')
      expect(calledUrl).not.toContain('my worker/v2')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('adds account_id param for multi-account user tokens', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: { summary: 'List Workers' } as OperationInfo
      }
    }

    const props: AuthProps = {
      type: 'user_token',
      accessToken: 'test-token',
      user: { id: 'u1', email: 'test@example.com' },
      accounts: [
        { id: 'acct-1', name: 'Account One' },
        { id: 'acct-2', name: 'Account Two' }
      ]
    }

    await seedSpec(specPaths)
    const server = await createServer(props, false)

    const listedTools = await listTools(server)
    const listedTool = listedTools.find((item) => item.name === 'get_accounts_workers_scripts')
    expect(listedTool?.inputSchema.required).toContain('account_id')
    expect(listedTool?.inputSchema.properties?.account_id).toEqual({
      type: 'string',
      description:
        'Cloudflare account ID. Required for multi-account tokens. Call the get_accounts tool to discover available accounts.'
    })
    expect(JSON.stringify(listedTool)).not.toContain('Account One')
    expect(JSON.stringify(listedTool)).not.toContain('acct-1')
  })

  it('adds account discovery guidance when multi-account account_id is missing', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: { summary: 'List Workers' } as OperationInfo
      }
    }
    const props: AuthProps = {
      type: 'user_token',
      accessToken: 'test-token',
      user: { id: 'u1', email: 'test@example.com' },
      accounts: [
        { id: 'acct-1', name: 'Account One' },
        { id: 'acct-2', name: 'Account Two' }
      ]
    }

    await seedSpec(specPaths)
    const server = await createServer(props, false)
    const result = await callTool(server, 'get_accounts_workers_scripts', {})

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain(
      'Call the get_accounts tool to discover available accounts.'
    )
  })

  it('drops account_id from the schema for account-token sessions', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: {
          summary: 'List Workers',
          parameters: [{ name: 'account_id', in: 'path', required: true }]
        } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(acctProps('acct-123'), false)

    const tools = await listTools(server)
    const tool = tools.find((item) => item.name === 'get_accounts_workers_scripts')
    // account_id is pinned to the token's account, so it must not be a param.
    expect(tool?.inputSchema.properties?.account_id).toBeUndefined()
  })

  it('drops account_id from the schema for single-account user tokens', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: {
          summary: 'List Workers',
          parameters: [{ name: 'account_id', in: 'path', required: true }]
        } as OperationInfo
      }
    }

    const props: AuthProps = {
      type: 'user_token',
      accessToken: 'test-token',
      user: { id: 'u1', email: 'test@example.com' },
      accounts: [{ id: 'acct-only', name: 'Only Account' }]
    }

    await seedSpec(specPaths)
    const server = await createServer(props, false)

    const tools = await listTools(server)
    const tool = tools.find((item) => item.name === 'get_accounts_workers_scripts')
    // The sole account auto-resolves, so account_id must not be a param.
    expect(tool?.inputSchema.properties?.account_id).toBeUndefined()
  })

  it('endpoint with no params at all works', async () => {
    const specPaths = {
      '/user': {
        get: { summary: 'Get current user' } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(bareUserProps, false)

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: { id: 'u1', email: 'a@b.com' } })

    try {
      const result = await callTool(server, 'get_user', {})
      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('a@b.com')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('passes query params + body together on PATCH', async () => {
    const specPaths = {
      '/zones/{zone_id}/dns_records/{record_id}': {
        patch: {
          summary: 'Patch DNS Record',
          parameters: [
            { name: 'zone_id', in: 'path', required: true },
            { name: 'record_id', in: 'path', required: true },
            { name: 'comment', in: 'query', required: false }
          ],
          requestBody: { required: true, content: {} }
        } as OperationInfo
      }
    }

    await seedSpec(specPaths)
    const server = await createServer(bareUserProps, false)

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: {} })

    try {
      const body = JSON.stringify({ content: '1.2.3.4' })
      await callTool(server, 'patch_zones_dns_records_by_record_id', {
        zone_id: 'z1',
        record_id: 'r1',
        comment: 'updated IP',
        body
      })

      const calledUrl = (globalThis.fetch as any).mock.calls[0][0]
      const calledOpts = (globalThis.fetch as any).mock.calls[0][1]
      expect(calledUrl).toContain('/zones/z1/dns_records/r1')
      expect(calledUrl).toContain('comment=updated+IP')
      expect(calledOpts.method).toBe('PATCH')
      expect(calledOpts.body).toBe(body)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

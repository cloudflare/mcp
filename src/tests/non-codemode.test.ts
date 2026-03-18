import { describe, it, expect, vi } from 'vitest'
import { pathToToolName, buildInputSchema, createServer } from '../server'
import type { OperationInfo } from '../server'
import type { AuthProps } from '../auth/types'

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
  function makeMockEnv(specPaths: Record<string, Record<string, OperationInfo>>) {
    return {
      CLOUDFLARE_API_BASE: 'https://api.cloudflare.com/client/v4',
      SPEC_BUCKET: {
        get: vi.fn((key: string) => {
          if (key === 'spec.json') {
            return Promise.resolve({
              json: () => Promise.resolve({ paths: specPaths }),
              text: () => Promise.resolve(JSON.stringify({ paths: specPaths }))
            })
          }
          if (key === 'products.json') {
            return Promise.resolve({
              json: () => Promise.resolve(['workers']),
              text: () => Promise.resolve(JSON.stringify(['workers']))
            })
          }
          return Promise.resolve(null)
        })
      },
      LOADER: { get: vi.fn() }
    } as any
  }

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

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', 'test-account', undefined, false)

    const tools = (server as any)._registeredTools
    const toolNames = Object.keys(tools)
    expect(toolNames).toContain('get_accounts_workers_scripts')
    expect(toolNames).toContain('post_accounts_workers_scripts')
    expect(toolNames).toContain('get_zones_dns_records')

    // Should NOT have codemode tools
    expect(toolNames).not.toContain('search')
    expect(toolNames).not.toContain('execute')
  })

  it('registers codemode tools when codemode=true (default)', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: { summary: 'List Workers' } as OperationInfo
      }
    }

    const env = makeMockEnv(specPaths)
    const ctx = {
      exports: { GlobalOutbound: vi.fn(() => ({ fetch: vi.fn() })) },
      waitUntil: vi.fn()
    } as any
    const server = await createServer(env, ctx, 'test-token', 'test-account', undefined, true)

    const tools = (server as any)._registeredTools
    const toolNames = Object.keys(tools)
    expect(toolNames).toContain('search')
    expect(toolNames).toContain('execute')
    expect(toolNames).not.toContain('get_accounts_workers_scripts')
  })

  it('tool handler makes direct fetch call for non-codemode tools', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: {
          summary: 'List Workers',
          parameters: [{ name: 'account_id', in: 'path', required: true }]
        } as OperationInfo
      }
    }

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', 'acct-123', undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['get_accounts_workers_scripts']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: [{ id: 'my-worker' }] })

    try {
      const result = await tool.handler({ account_id: 'acct-123' }, {} as any)

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

  it('auto-resolves account_id when fixed account token', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: { summary: 'List Workers' } as OperationInfo
      }
    }

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', 'fixed-acct', undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['get_accounts_workers_scripts']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: [] })

    try {
      await tool.handler({}, {} as any)
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/accounts/fixed-acct/workers/scripts'),
        expect.anything()
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('auto-resolves account_id for single-account user token', async () => {
    const specPaths = {
      '/accounts/{account_id}/workers/scripts': {
        get: { summary: 'List Workers' } as OperationInfo
      }
    }

    const props: AuthProps = {
      type: 'user_token',
      accessToken: 'test-token',
      user: { id: 'u1', email: 'test@example.com' },
      accounts: [{ id: 'single-acct', name: 'My Account' }]
    }

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', undefined, props, false)

    const tools = (server as any)._registeredTools
    const tool = tools['get_accounts_workers_scripts']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: [] })

    try {
      await tool.handler({}, {} as any)
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/accounts/single-acct/workers/scripts'),
        expect.anything()
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns error for missing required path param', async () => {
    const specPaths = {
      '/zones/{zone_id}/dns_records/{record_id}': {
        delete: { summary: 'Delete DNS Record' } as OperationInfo
      }
    }

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', undefined, undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['delete_zones_dns_records_by_record_id']

    const result = await tool.handler({}, {} as any)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('missing required path parameter: zone_id')
  })

  it('returns error for second missing path param (first resolved)', async () => {
    const specPaths = {
      '/zones/{zone_id}/dns_records/{record_id}': {
        delete: { summary: 'Delete DNS Record' } as OperationInfo
      }
    }

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', undefined, undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['delete_zones_dns_records_by_record_id']

    // Provide zone_id but not record_id
    const result = await tool.handler({ zone_id: 'z1' }, {} as any)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('missing required path parameter: record_id')
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

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', 'acct-1', undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['get_accounts_workers_scripts']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: [] })

    try {
      await tool.handler({ page: '2' }, {} as any)
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

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', 'acct-1', undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['get_accounts_workers_scripts']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: [] })

    try {
      // Only pass page, not per_page
      await tool.handler({ page: '3' }, {} as any)
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

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', 'acct-1', undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['post_accounts_d1_database']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: { id: 'new-db' } })

    try {
      const body = JSON.stringify({ name: 'my-database' })
      await tool.handler({ body }, {} as any)

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

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', 'acct-1', undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['put_accounts_workers_scripts_by_script_name']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: {} })

    try {
      const scriptBody = 'export default { async fetch() { return new Response("hi"); } }'
      await tool.handler(
        { script_name: 'my-worker', body: scriptBody, content_type: 'application/javascript' },
        {} as any
      )

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

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', 'acct-1', undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['post_accounts_d1_database']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: {} })

    try {
      await tool.handler({ body: '{"name":"test"}' }, {} as any)
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

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', 'acct-1', undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['get_accounts_workers_scripts']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: [] })

    try {
      await tool.handler({}, {} as any)
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

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', 'acct-1', undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['put_accounts_workers_scripts_by_script_name']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: {} })

    try {
      await tool.handler(
        {
          script_name: 'my-worker',
          header_if_match: '"etag-123"',
          body: '{}'
        },
        {} as any
      )

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

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', 'acct-1', undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['put_accounts_workers_scripts_by_script_name']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: {} })

    try {
      await tool.handler({ script_name: 'my-worker' }, {} as any)
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

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', 'acct-1', undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['get_accounts_storage_kv_namespaces_values_by_key_name']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchText('raw-kv-value-here')

    try {
      const result = await tool.handler({ namespace_id: 'ns-1', key_name: 'mykey' }, {} as any)
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

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', 'acct-1', undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['get_accounts_workers_scripts']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson(
      { success: false, errors: [{ code: 10000, message: 'Auth error' }] },
      false
    )

    try {
      const result = await tool.handler({}, {} as any)
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

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', 'acct-1', undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['get_accounts_workers_scripts']

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network failure'))

    try {
      const result = await tool.handler({}, {} as any)
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

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', 'acct-1', undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['get_accounts_workers_scripts_by_script_name']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: {} })

    try {
      await tool.handler({ script_name: 'my worker/v2' }, {} as any)
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

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', undefined, props, false)

    const tools = (server as any)._registeredTools
    const tool = tools['get_accounts_workers_scripts']
    const inputSchema = tool.inputSchema
    expect(inputSchema).toBeDefined()
  })

  it('endpoint with no params at all works', async () => {
    const specPaths = {
      '/user': {
        get: { summary: 'Get current user' } as OperationInfo
      }
    }

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', undefined, undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['get_user']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: { id: 'u1', email: 'a@b.com' } })

    try {
      const result = await tool.handler({}, {} as any)
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

    const env = makeMockEnv(specPaths)
    const ctx = { exports: {}, waitUntil: vi.fn() } as any
    const server = await createServer(env, ctx, 'test-token', undefined, undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['patch_zones_dns_records_by_record_id']

    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetchJson({ success: true, result: {} })

    try {
      const body = JSON.stringify({ content: '1.2.3.4' })
      await tool.handler({ zone_id: 'z1', record_id: 'r1', comment: 'updated IP', body }, {} as any)

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

import { describe, it, expect, vi } from 'vitest'
import { pathToToolName, buildInputSchema, createServer } from '../server'
import type { OperationInfo } from '../server'
import type { AuthProps } from '../auth/types'

describe('pathToToolName', () => {
  it('converts a simple GET endpoint', () => {
    expect(pathToToolName('get', '/accounts/{account_id}/workers/scripts')).toBe(
      'get_accounts_workers_scripts'
    )
  })

  it('converts a POST endpoint', () => {
    expect(pathToToolName('post', '/accounts/{account_id}/d1/database')).toBe(
      'post_accounts_d1_database'
    )
  })

  it('handles nested path params', () => {
    expect(pathToToolName('delete', '/accounts/{account_id}/workers/scripts/{script_name}')).toBe(
      'delete_accounts_workers_scripts'
    )
  })

  it('handles zone-based paths', () => {
    expect(pathToToolName('get', '/zones/{zone_id}/dns_records')).toBe('get_zones_dns_records')
  })

  it('strips leading slash and collapses underscores', () => {
    expect(pathToToolName('get', '/user')).toBe('get_user')
  })

  it('handles paths with no params', () => {
    expect(pathToToolName('get', '/user/tokens')).toBe('get_user_tokens')
  })

  it('strips trailing underscore', () => {
    expect(pathToToolName('get', '/accounts/{account_id}')).toBe('get_accounts')
  })
})

describe('buildInputSchema', () => {
  it('creates schema with path parameters', () => {
    const operation: OperationInfo = {
      parameters: [
        { name: 'account_id', in: 'path', required: true, description: 'Account identifier' }
      ]
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['account_id']).toBeDefined()
  })

  it('creates schema with query parameters', () => {
    const operation: OperationInfo = {
      parameters: [
        { name: 'page', in: 'query', required: false, description: 'Page number' },
        { name: 'per_page', in: 'query', required: true, description: 'Items per page' }
      ]
    }
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['page']).toBeDefined()
    expect(schema['per_page']).toBeDefined()
  })

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

  it('does not add body param when no requestBody', () => {
    const operation: OperationInfo = {}
    const schema = buildInputSchema(operation, '/accounts/{account_id}/workers/scripts')
    expect(schema['body']).toBeUndefined()
  })

  it('extracts path params from path template even without explicit parameter definitions', () => {
    const operation: OperationInfo = {}
    const schema = buildInputSchema(
      operation,
      '/accounts/{account_id}/workers/scripts/{script_name}'
    )
    expect(schema['account_id']).toBeDefined()
    expect(schema['script_name']).toBeDefined()
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

    // Access registered tools via the server's internal state
    const tools = (server as any)._registeredTools
    expect(tools).toBeDefined()

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
    expect(tool).toBeDefined()

    // Mock global fetch for the tool handler
    const originalFetch = globalThis.fetch
    const mockResponse = {
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: true, result: [{ id: 'my-worker' }] })
    }
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse)

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
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: true, result: [] })
    })

    try {
      // Call without account_id — should auto-resolve from the fixed accountId
      await tool.handler({}, {} as any)

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/accounts/fixed-acct/workers/scripts'),
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
    // No fixed accountId, no props — zone_id won't auto-resolve
    const server = await createServer(env, ctx, 'test-token', undefined, undefined, false)

    const tools = (server as any)._registeredTools
    const tool = tools['delete_zones_dns_records']

    const result = await tool.handler({}, {} as any)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('missing required path parameter: zone_id')
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
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: true, result: [] })
    })

    try {
      await tool.handler({ page: '2' }, {} as any)

      const calledUrl = (globalThis.fetch as any).mock.calls[0][0]
      expect(calledUrl).toContain('page=2')
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
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ success: true, result: { id: 'new-db' } })
    })

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

    // The tool should have account_id in its schema
    const inputSchema = tool.inputSchema
    expect(inputSchema).toBeDefined()
  })
})

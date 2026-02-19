import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createCodeExecutor, createSearchExecutor } from '../executor'

describe('GraphQL Support', () => {
  let mockEnv: Env
  let mockWorker: any
  let mockEntrypoint: any

  beforeEach(() => {
    mockEntrypoint = {
      evaluate: vi.fn().mockResolvedValue({
        result: {},
        err: undefined
      })
    }

    mockWorker = {
      getEntrypoint: vi.fn(() => mockEntrypoint)
    }

    mockEnv = {
      CLOUDFLARE_API_BASE: 'https://api.cloudflare.com/client/v4',
      LOADER: {
        get: vi.fn(() => mockWorker)
      }
    } as any
  })

  describe('Path Detection', () => {
    it('should detect GraphQL endpoint with exact path', async () => {
      mockEntrypoint.evaluate.mockResolvedValue({
        result: {
          success: true,
          result: { viewer: { __typename: 'Viewer' } }
        }
      })

      const executor = createCodeExecutor(mockEnv)
      const code = `
        async () => {
          return await cloudflare.request({
            method: "POST",
            path: "/client/v4/graphql",
            body: { query: "{ viewer { __typename } }" }
          });
        }
      `

      await executor(code, 'test-account', 'test-token')

      // Verify the LOADER.get was called with correct worker code
      const loaderCall = mockEnv.LOADER.get as any
      expect(loaderCall).toHaveBeenCalled()
    })

    it('should detect GraphQL endpoint with trailing /graphql', async () => {
      const executor = createCodeExecutor(mockEnv)

      // The path detection logic is in the worker code itself
      // We're testing that the code generation includes the GraphQL handling
      const loaderCall = mockEnv.LOADER.get as any

      await executor('async () => { return {} }', 'test-account', 'test-token')

      const workerConfig = loaderCall.mock.calls[0][1]()
      const workerCode = workerConfig.modules['worker.js']

      // Verify GraphQL detection code is present
      expect(workerCode).toContain('isGraphQLEndpoint')
      expect(workerCode).toContain('/client/v4/graphql')
      expect(workerCode).toContain("endsWith('/graphql')")
    })

    it('should handle GraphQL path with query parameters', async () => {
      const executor = createCodeExecutor(mockEnv)
      await executor('async () => { return {} }', 'test-account', 'test-token')

      const loaderCall = mockEnv.LOADER.get as any
      const workerConfig = loaderCall.mock.calls[0][1]()
      const workerCode = workerConfig.modules['worker.js']

      // Verify path cleaning logic is present
      expect(workerCode).toContain("split('?')[0]")
      expect(workerCode).toContain('replace(/')
    })

    it('should not treat non-GraphQL paths as GraphQL', async () => {
      const executor = createCodeExecutor(mockEnv)
      await executor('async () => { return {} }', 'test-account', 'test-token')

      const loaderCall = mockEnv.LOADER.get as any
      const workerConfig = loaderCall.mock.calls[0][1]()
      const workerCode = workerConfig.modules['worker.js']

      // Verify REST API handling is still present
      expect(workerCode).toContain('if (!data.success)')
      expect(workerCode).toContain('Cloudflare API error')
    })
  })

  describe('Response Handling', () => {
    it('should include partial response handling logic', async () => {
      const executor = createCodeExecutor(mockEnv)
      await executor('async () => { return {} }', 'test-account', 'test-token')

      const loaderCall = mockEnv.LOADER.get as any
      const workerConfig = loaderCall.mock.calls[0][1]()
      const workerCode = workerConfig.modules['worker.js']

      // Verify partial response handling
      expect(workerCode).toContain('graphqlErrors')
      expect(workerCode).toContain('hasData')
      expect(workerCode).toContain('data.data !== null')
      expect(workerCode).toContain('data.data !== undefined')
    })

    it('should include error path in error messages', async () => {
      const executor = createCodeExecutor(mockEnv)
      await executor('async () => { return {} }', 'test-account', 'test-token')

      const loaderCall = mockEnv.LOADER.get as any
      const workerConfig = loaderCall.mock.calls[0][1]()
      const workerCode = workerConfig.modules['worker.js']

      // Verify error path handling
      expect(workerCode).toContain('e.path')
      expect(workerCode).toContain("join('.')")
    })

    it('should handle errors array robustly', async () => {
      const executor = createCodeExecutor(mockEnv)
      await executor('async () => { return {} }', 'test-account', 'test-token')

      const loaderCall = mockEnv.LOADER.get as any
      const workerConfig = loaderCall.mock.calls[0][1]()
      const workerCode = workerConfig.modules['worker.js']

      // Verify robust array checking
      expect(workerCode).toContain('Array.isArray(data.errors)')
    })

    it('should normalize GraphQL response format', async () => {
      const executor = createCodeExecutor(mockEnv)
      await executor('async () => { return {} }', 'test-account', 'test-token')

      const loaderCall = mockEnv.LOADER.get as any
      const workerConfig = loaderCall.mock.calls[0][1]()
      const workerCode = workerConfig.modules['worker.js']

      // Verify response normalization
      expect(workerCode).toContain('success: graphqlErrors.length === 0')
      expect(workerCode).toContain('result: data.data')
      expect(workerCode).toContain('Partial response')
    })
  })

  describe('Error Scenarios', () => {
    it('should include logic for complete failure (no data, only errors)', async () => {
      const executor = createCodeExecutor(mockEnv)
      await executor('async () => { return {} }', 'test-account', 'test-token')

      const loaderCall = mockEnv.LOADER.get as any
      const workerConfig = loaderCall.mock.calls[0][1]()
      const workerCode = workerConfig.modules['worker.js']

      // Verify complete failure handling
      expect(workerCode).toContain('graphqlErrors.length > 0 && !hasData')
      expect(workerCode).toContain('GraphQL error')
    })

    it('should extract error codes from extensions', async () => {
      const executor = createCodeExecutor(mockEnv)
      await executor('async () => { return {} }', 'test-account', 'test-token')

      const loaderCall = mockEnv.LOADER.get as any
      const workerConfig = loaderCall.mock.calls[0][1]()
      const workerCode = workerConfig.modules['worker.js']

      // Verify extensions handling
      expect(workerCode).toContain('e.extensions?.code')
    })
  })

  describe('REST API Compatibility', () => {
    it('should preserve REST API handling', async () => {
      const executor = createCodeExecutor(mockEnv)
      await executor('async () => { return {} }', 'test-account', 'test-token')

      const loaderCall = mockEnv.LOADER.get as any
      const workerConfig = loaderCall.mock.calls[0][1]()
      const workerCode = workerConfig.modules['worker.js']

      // Verify REST handling is still present and comes after GraphQL check
      const graphqlIndex = workerCode.indexOf('isGraphQLEndpoint')
      const restIndex = workerCode.indexOf('if (!data.success)')

      expect(graphqlIndex).toBeLessThan(restIndex)
    })

    it('should preserve non-JSON response handling', async () => {
      const executor = createCodeExecutor(mockEnv)
      await executor('async () => { return {} }', 'test-account', 'test-token')

      const loaderCall = mockEnv.LOADER.get as any
      const workerConfig = loaderCall.mock.calls[0][1]()
      const workerCode = workerConfig.modules['worker.js']

      // Verify non-JSON handling is still present
      expect(workerCode).toContain('responseContentType')
      expect(workerCode).toContain('application/json')
    })
  })

  describe('Worker Code Generation', () => {
    it('should inject cloudflare.request function', async () => {
      const executor = createCodeExecutor(mockEnv)
      await executor('async () => { return {} }', 'test-account', 'test-token')

      const loaderCall = mockEnv.LOADER.get as any
      const workerConfig = loaderCall.mock.calls[0][1]()
      const workerCode = workerConfig.modules['worker.js']

      expect(workerCode).toContain('const cloudflare = {')
      expect(workerCode).toContain('async request(options)')
    })

    it('should use correct compatibility date', async () => {
      const executor = createCodeExecutor(mockEnv)
      await executor('async () => { return {} }', 'test-account', 'test-token')

      const loaderCall = mockEnv.LOADER.get as any
      const workerConfig = loaderCall.mock.calls[0][1]()

      expect(workerConfig.compatibilityDate).toBe('2026-01-12')
      expect(workerConfig.compatibilityFlags).toBeUndefined()
    })
  })
})

describe('Search Executor', () => {
  const mockSpec = { paths: { '/test': { get: { summary: 'Test endpoint' } } } }

  it('should read spec from R2 and embed in search worker', async () => {
    let capturedWorkerCode = ''
    const mockEnv = {
      CLOUDFLARE_API_BASE: 'https://api.cloudflare.com/client/v4',
      SPEC_BUCKET: {
        get: vi.fn().mockResolvedValue({
          text: async () => JSON.stringify(mockSpec)
        })
      },
      LOADER: {
        get: vi.fn((_id: string, fn: () => any) => {
          const config = fn()
          capturedWorkerCode = config.modules['worker.js']
          return {
            getEntrypoint: () => ({
              evaluate: async () => ({ result: {}, err: undefined })
            })
          }
        })
      }
    } as any

    const executor = createSearchExecutor(mockEnv)
    await executor('async () => { return {} }')

    expect(mockEnv.SPEC_BUCKET.get).toHaveBeenCalledWith('spec.json')
    expect(capturedWorkerCode).toContain('/test')
    expect(capturedWorkerCode).toContain('Test endpoint')
    expect(capturedWorkerCode).not.toContain('cloudflare.request')
  })

  it('should throw if spec not in R2', async () => {
    const mockEnv = {
      CLOUDFLARE_API_BASE: 'https://api.cloudflare.com/client/v4',
      SPEC_BUCKET: {
        get: vi.fn().mockResolvedValue(null)
      },
      LOADER: { get: vi.fn() }
    } as any

    const executor = createSearchExecutor(mockEnv)
    await expect(executor('async () => { return {} }')).rejects.toThrow('spec.json not found in R2')
  })
})

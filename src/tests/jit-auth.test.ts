import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createCodeExecutor } from '../executor'
import { elicitUpdatedScopes } from '../server'

describe('JIT Auth - HTTP Status Propagation', () => {
  let mockEnv: Env
  let mockCtx: any
  let mockWorker: any
  let mockEntrypoint: any

  beforeEach(() => {
    mockEntrypoint = {
      evaluate: vi.fn()
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

    mockCtx = {
      exports: {
        GlobalOutbound: vi.fn(() => ({ fetch: vi.fn() }))
      }
    } as any
  })

  describe('Executor httpStatus propagation', () => {
    it('should include httpStatus in worker code error handling', async () => {
      mockEntrypoint.evaluate.mockResolvedValue({ result: {}, err: undefined })
      const executor = createCodeExecutor(mockEnv, mockCtx)
      await executor('async () => { return {} }', 'test-account', 'test-token')

      const loaderCall = mockEnv.LOADER.get as any
      const workerConfig = loaderCall.mock.calls[0][1]()
      const workerCode = workerConfig.modules['worker.js']

      expect(workerCode).toContain('err.httpStatus = response.status')
      expect(workerCode).toContain('err.httpStatus')
    })

    it('should propagate httpStatus 403 from sandbox response to thrown error', async () => {
      mockEntrypoint.evaluate.mockResolvedValue({
        result: undefined,
        err: 'Cloudflare API error: 10000: Authentication error',
        stack: 'Error: ...',
        httpStatus: 403
      })

      const executor = createCodeExecutor(mockEnv, mockCtx)

      try {
        await executor('async () => {}', 'test-account', 'test-token')
        expect.unreachable('should have thrown')
      } catch (error: any) {
        expect(error).toBeInstanceOf(Error)
        expect(error.message).toBe('Cloudflare API error: 10000: Authentication error')
        expect(error.httpStatus).toBe(403)
      }
    })

    it('should propagate httpStatus 500 from sandbox', async () => {
      mockEntrypoint.evaluate.mockResolvedValue({
        result: undefined,
        err: 'Cloudflare API error: Internal Server Error',
        stack: 'Error: ...',
        httpStatus: 500
      })

      const executor = createCodeExecutor(mockEnv, mockCtx)

      try {
        await executor('async () => {}', 'test-account', 'test-token')
        expect.unreachable('should have thrown')
      } catch (error: any) {
        expect(error).toBeInstanceOf(Error)
        expect(error.httpStatus).toBe(500)
      }
    })

    it('should not set httpStatus when sandbox error has no status', async () => {
      mockEntrypoint.evaluate.mockResolvedValue({
        result: undefined,
        err: 'User code threw an error',
        stack: 'Error: ...'
      })

      const executor = createCodeExecutor(mockEnv, mockCtx)

      try {
        await executor('async () => {}', 'test-account', 'test-token')
        expect.unreachable('should have thrown')
      } catch (error: any) {
        expect(error).toBeInstanceOf(Error)
        expect(error.message).toBe('User code threw an error')
        expect(error.httpStatus).toBeUndefined()
      }
    })
  })
})

describe('JIT Auth - elicitUpdatedScopes', () => {
  it('should return tool error with URL for 403 errors (no ctx)', async () => {
    const error = new Error('Cloudflare API error: 10000: Authentication error')
    ;(error as any).httpStatus = 403

    const result = await elicitUpdatedScopes(error)
    expect(result).toBeDefined()
    expect(result!.isError).toBe(true)
    expect(result!.content[0].text).toContain('10000: Authentication error')
    expect(result!.content[0].text).toContain(
      'https://developers.cloudflare.com/fundamentals/api/reference/permissions/'
    )
  })

  it('should include re-authorize URL in the tool error message', async () => {
    const error = new Error('Cloudflare API error: 10000: Authentication error')
    ;(error as any).httpStatus = 403

    const result = await elicitUpdatedScopes(error)
    expect(result!.content[0].text).toContain('Upgrade permissions here:')
  })

  it('should return undefined for non-403 errors', async () => {
    const error = new Error('Cloudflare API error: Internal Server Error')
    ;(error as any).httpStatus = 500

    const result = await elicitUpdatedScopes(error)
    expect(result).toBeUndefined()
  })

  it('should return undefined for errors without httpStatus', async () => {
    const error = new Error('some user error')

    const result = await elicitUpdatedScopes(error)
    expect(result).toBeUndefined()
  })

  it('should return undefined for non-Error values', async () => {
    expect(await elicitUpdatedScopes('some string error')).toBeUndefined()
    expect(await elicitUpdatedScopes(42)).toBeUndefined()
    expect(await elicitUpdatedScopes(null)).toBeUndefined()
    expect(await elicitUpdatedScopes(undefined)).toBeUndefined()
  })
})

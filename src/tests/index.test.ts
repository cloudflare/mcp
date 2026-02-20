import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Import the default export (the worker)
import worker from '../index'

describe('scheduled handler', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('should fetch spec from GitHub, process it, and write spec + products to R2', async () => {
    const rawSpec = {
      openapi: '3.0.0',
      info: { title: 'Test', version: '1.0' },
      paths: {
        '/accounts/{account_id}/workers/scripts': {
          get: {
            summary: 'List Workers',
            tags: ['Workers Scripts'],
            parameters: [],
            responses: { '200': { description: 'OK' } }
          }
        }
      }
    }

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(rawSpec), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )

    const stored: Record<string, string> = {}
    const mockEnv = {
      OPENAPI_SPEC_URL:
        'https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json',
      SPEC_BUCKET: {
        put: vi.fn(async (key: string, data: string, _options: any) => {
          stored[key] = data
        })
      }
    } as any

    const controller = { scheduledTime: Date.now(), cron: '0 0 * * *' } as any
    const ctx = { waitUntil: vi.fn() } as any

    await worker.scheduled(controller, mockEnv, ctx)

    // Should have fetched from GitHub
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json'
    )

    // Should have written both spec and products to R2
    expect(mockEnv.SPEC_BUCKET.put).toHaveBeenCalledWith('spec.json', expect.any(String), {
      httpMetadata: { contentType: 'application/json' }
    })
    expect(mockEnv.SPEC_BUCKET.put).toHaveBeenCalledWith('products.json', expect.any(String), {
      httpMetadata: { contentType: 'application/json' }
    })

    // Verify spec
    const parsedSpec = JSON.parse(stored['spec.json'])
    expect(parsedSpec.paths).toBeDefined()
    expect(parsedSpec.paths['/accounts/{account_id}/workers/scripts']).toBeDefined()

    // Verify products
    const parsedProducts = JSON.parse(stored['products.json'])
    expect(Array.isArray(parsedProducts)).toBe(true)
    expect(parsedProducts).toContain('workers')
  })

  it('should throw if GitHub fetch fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 }))

    const mockEnv = {
      OPENAPI_SPEC_URL:
        'https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json',
      SPEC_BUCKET: { put: vi.fn() }
    } as any
    const controller = { scheduledTime: Date.now(), cron: '0 0 * * *' } as any
    const ctx = { waitUntil: vi.fn() } as any

    await expect(worker.scheduled(controller, mockEnv, ctx)).rejects.toThrow(
      'Failed to fetch OpenAPI spec: 404'
    )
  })
})

import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMcpTools, resetIsolateCache } from '../src/isolate-cache'
import type { OperationInfo } from '../src/openapi'
import { clearSpec, seedSpec } from './helpers/spec'

const PATHS = { '/user': { get: { summary: 'Get current user' } as OperationInfo } }

afterEach(async () => {
  vi.restoreAllMocks()
  await clearSpec()
})

describe('isolate cache', () => {
  it('loads mcp-tools.json once for concurrent requests on a cold isolate', async () => {
    await seedSpec(PATHS)
    const get = vi.spyOn(env.SPEC_BUCKET, 'get')

    const results = await Promise.all(Array.from({ length: 10 }, () => getMcpTools()))

    expect(get.mock.calls.filter(([key]) => key === 'mcp-tools.json')).toHaveLength(1)
    expect(new Set(results).size).toBe(1)
  })

  it('serves the same tools/list payload to every request on a warm isolate', async () => {
    await seedSpec(PATHS)

    const first = await getMcpTools()
    const second = await getMcpTools()

    expect(second.list).toBe(first.list)
    expect(first.list).toEqual([
      {
        name: 'get_user',
        title: 'Get User',
        description: 'GET /user\n\nGet current user',
        inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {} }
      }
    ])
  })

  it('does not cache a failed load', async () => {
    resetIsolateCache()
    await expect(getMcpTools()).rejects.toThrow('mcp-tools.json not found in R2')

    await seedSpec(PATHS)
    await expect(getMcpTools()).resolves.toMatchObject({ list: [{ name: 'get_user' }] })
  })
})

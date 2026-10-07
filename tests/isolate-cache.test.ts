import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDirectTools, resetIsolateCache } from '../src/isolate-cache'
import { directTool } from './helpers/direct-tools'
import { clearSpec, seedSpec } from './helpers/spec'

afterEach(async () => {
  vi.restoreAllMocks()
  await clearSpec()
})

describe('isolate cache', () => {
  it('loads mcp-tools.json once for concurrent requests on a cold isolate', async () => {
    await seedSpec({}, ['workers'], [directTool({ name: 'user_get', path: '/user' })])
    const get = vi.spyOn(env.SPEC_BUCKET, 'get')

    const results = await Promise.all(Array.from({ length: 10 }, () => getDirectTools()))

    expect(get.mock.calls.filter(([key]) => key === 'mcp-tools.json')).toHaveLength(1)
    expect(new Set(results).size).toBe(1)
  })

  it('does not cache a failed load', async () => {
    resetIsolateCache()
    await expect(getDirectTools()).rejects.toThrow('mcp-tools.json not found in R2')

    await seedSpec({}, ['workers'], [directTool({ name: 'user_get', path: '/user' })])
    await expect(getDirectTools()).resolves.toMatchObject({ list: [{ name: 'user_get' }] })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMcpTools, setSpecArtifactSource } from '../src/isolate-cache'
import { isolate } from '../src/lib/isolate'
import { buildMcpTools, type OperationInfo } from '../src/openapi'
import { clearSpec, seedSpec } from './helpers/spec'

const PATHS = { '/user': { get: { summary: 'Get current user' } as OperationInfo } }

afterEach(async () => {
  vi.restoreAllMocks()
  await clearSpec()
})

describe('isolate cache', () => {
  it('loads mcp-tools.json once for concurrent requests on a cold isolate', async () => {
    const source = vi.fn(async () => JSON.stringify(buildMcpTools(PATHS)))
    setSpecArtifactSource(source)

    const results = await Promise.all(Array.from({ length: 10 }, () => getMcpTools()))

    expect(source.mock.calls).toEqual([['mcp-tools.json']])
    expect(new Set(results).size).toBe(1)
  })

  it('reads the spec artifacts from the forge tools service by default', async () => {
    setSpecArtifactSource()

    const tools = await getMcpTools()

    expect(tools.list.length).toBeGreaterThan(1000)
    expect(tools.byName.has('get_accounts_d1_database')).toBe(true)
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
        inputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {}
        }
      }
    ])
  })

  it('does not cache a failed load', async () => {
    isolate.resetAll()
    await expect(getMcpTools()).rejects.toThrow('mcp-tools.json is not available')

    await seedSpec(PATHS)
    await expect(getMcpTools()).resolves.toMatchObject({ list: [{ name: 'get_user' }] })
  })
})

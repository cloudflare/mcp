import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPermissionPaths, setSpecArtifactSource } from '../src/isolate-cache'
import { isolate } from '../src/lib/isolate'
import type { OperationInfo } from '../src/openapi'
import { clearSpec, seedSpec } from './helpers/spec'

const PATHS = {
  '/user': {
    get: {
      summary: 'Get current user',
      'x-api-token-group': ['User Details Read']
    } as OperationInfo
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await clearSpec()
})

describe('isolate cache', () => {
  it('loads permissions.json once for concurrent requests on a cold isolate', async () => {
    const source = vi.fn(async () => JSON.stringify({ '/user': { get: {} } }))
    setSpecArtifactSource(source)

    const results = await Promise.all(Array.from({ length: 10 }, () => getPermissionPaths()))

    expect(source.mock.calls).toEqual([['permissions.json']])
    expect(new Set(results).size).toBe(1)
  })

  it('reads the spec artifacts from the forge tools service by default', async () => {
    setSpecArtifactSource()

    const paths = await getPermissionPaths()

    expect(paths['/accounts/{account_id}/d1/database'].get['x-api-token-group']).toContain(
      'D1 Read'
    )
  })

  it('serves the same permissions to every request on a warm isolate', async () => {
    await seedSpec(PATHS)

    const first = await getPermissionPaths()

    expect(await getPermissionPaths()).toBe(first)
    expect(first).toEqual({ '/user': { get: { 'x-api-token-group': ['User Details Read'] } } })
  })

  it('does not cache a failed load', async () => {
    isolate.resetAll()
    await expect(getPermissionPaths()).rejects.toThrow('permissions.json is not available')

    await seedSpec(PATHS)
    await expect(getPermissionPaths()).resolves.toHaveProperty('/user')
  })
})

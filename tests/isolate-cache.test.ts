import { afterEach, describe, expect, it } from 'vitest'
import { getPermissionPaths, getProducts, setSpecArtifacts } from '../src/isolate-cache'
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
  await clearSpec()
})

describe('isolate cache', () => {
  it("reads the pinned release's spec artifacts from the bundle by default", () => {
    setSpecArtifacts()

    expect(
      getPermissionPaths()['/accounts/{account_id}/d1/database'].get['x-api-token-group']
    ).toContain('D1 Read')
    expect(getProducts()).toContain('workers')
  })

  it('serves the same permissions to every request on a warm isolate', async () => {
    await seedSpec(PATHS)

    const first = getPermissionPaths()

    expect(getPermissionPaths()).toBe(first)
    expect(first).toEqual({ '/user': { get: { 'x-api-token-group': ['User Details Read'] } } })
  })
})

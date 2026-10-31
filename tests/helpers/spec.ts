import { env } from 'cloudflare:workers'
import { setSpecArtifactSource, type SpecArtifactSource } from '../../src/isolate-cache'
import { clearR2 } from './r2'
import type { OperationInfo } from '../../src/openapi'
import type { SpecArtifactName } from '../../src/spec-release'

/**
 * Spec fixtures. The worker reads the spec artifacts from the forge tools
 * service, which ships the pinned release; tests serve small fixtures through
 * `setSpecArtifactSource` instead, and must clear them after each case.
 */

type SpecPaths = Record<string, Record<string, OperationInfo>>

/** A source serving `artifacts`; a name it lacks fails as unavailable. */
function fixtureSource(artifacts: Partial<Record<SpecArtifactName, string>>): SpecArtifactSource {
  return async (name) => {
    const text = artifacts[name]
    if (text === undefined) throw new Error(`${name} is not available`)
    return text
  }
}

/** Serve `products.json` and the `permissions.json` built from `paths`. */
export async function seedSpec(paths: SpecPaths, products: string[] = ['workers']): Promise<void> {
  setSpecArtifactSource(
    fixtureSource({
      'products.json': JSON.stringify(products),
      'permissions.json': JSON.stringify(
        Object.fromEntries(
          Object.entries(paths).map(([path, operations]) => [
            path,
            Object.fromEntries(
              Object.entries(operations).map(([method, operation]) => [
                method,
                operation['x-api-token-group']
                  ? { 'x-api-token-group': operation['x-api-token-group'] }
                  : {}
              ])
            )
          ])
        )
      )
    })
  )
}

/** Serve the products but no `permissions.json`. */
export async function removePermissions(): Promise<void> {
  setSpecArtifactSource(fixtureSource({ 'products.json': '[]' }))
}

/** Serve no spec (products stay an empty list), and wipe the bucket. Call in afterEach. */
export async function clearSpec(): Promise<void> {
  await clearR2(env.SPEC_BUCKET)
  setSpecArtifactSource(fixtureSource({ 'products.json': '[]' }))
}

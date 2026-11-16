import { env } from 'cloudflare:workers'
import { setSpecArtifacts } from '../../src/isolate-cache'
import { clearR2 } from './r2'
import type { OperationInfo } from '../../src/openapi'

/**
 * Spec fixtures. The worker reads the spec artifacts from its bundle, which
 * ships the pinned release; tests serve small fixtures through
 * `setSpecArtifacts` instead, and must clear them after each case.
 */

type SpecPaths = Record<string, Record<string, OperationInfo>>

/** Serve `products.json` and the `permissions.json` built from `paths`. */
export async function seedSpec(paths: SpecPaths, products: string[] = ['workers']): Promise<void> {
  setSpecArtifacts({
    products: JSON.stringify(products),
    permissions: JSON.stringify(
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
}

/** Serve an empty spec, with no products or operations, and wipe the bucket. Call in afterEach. */
export async function clearSpec(): Promise<void> {
  await clearR2(env.SPEC_BUCKET)
  setSpecArtifacts({ products: '[]', permissions: '{}' })
}

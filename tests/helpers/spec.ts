import { env } from 'cloudflare:workers'
import { resetIsolateCache } from '../../src/isolate-cache'
import { clearR2 } from './r2'
import { buildNonCodemodeTools, type OperationInfo } from '../../src/openapi'

/**
 * Spec-bucket test fixtures. vitest-pool-workers gives each test FILE a real,
 * shared R2 SPEC_BUCKET and the worker keeps an in-isolate spec cache, so tests
 * must seed before and wipe after each case to stay isolated.
 */

type SpecPaths = Record<string, Record<string, OperationInfo>>

/** Seed the real SPEC_BUCKET with a spec (+ products) and reset the cache. */
export async function seedSpec(paths: SpecPaths, products: string[] = ['workers']): Promise<void> {
  await env.SPEC_BUCKET.put('spec.json', JSON.stringify({ paths }))
  await env.SPEC_BUCKET.put('products.json', JSON.stringify(products))
  await env.SPEC_BUCKET.put('non-codemode-tools.json', JSON.stringify(buildNonCodemodeTools(paths)))
  resetIsolateCache()
}

/** Remove the precomputed artifact to exercise rolling-deploy fallback. */
export async function removeNonCodemodeTools(): Promise<void> {
  await env.SPEC_BUCKET.delete('non-codemode-tools.json')
  resetIsolateCache()
}

/** Wipe the spec bucket and the in-isolate spec cache. Call in afterEach. */
export async function clearSpec(): Promise<void> {
  await clearR2(env.SPEC_BUCKET)
  resetIsolateCache()
}

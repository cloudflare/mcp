import { env } from 'cloudflare:workers'
import { resetSpecCache } from '../../src/spec-cache'
import { clearR2 } from './r2'
import type { OperationInfo } from '../../src/openapi'

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
  resetSpecCache()
}

/** Wipe the spec bucket and the in-isolate spec cache. Call in afterEach. */
export async function clearSpec(): Promise<void> {
  await clearR2(env.SPEC_BUCKET)
  resetSpecCache()
}

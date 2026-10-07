import { env } from 'cloudflare:workers'
import { resetIsolateCache } from '../../src/isolate-cache'
import type { McpTool } from '../../src/mcp-tools'
import type { OperationInfo } from '../../src/openapi'
import { clearR2 } from './r2'

/**
 * Spec-bucket test fixtures. vitest-pool-workers gives each test FILE a real,
 * shared R2 SPEC_BUCKET and the worker keeps an in-isolate cache, so tests
 * must seed before and wipe after each case to stay isolated.
 */

type SpecPaths = Record<string, Record<string, OperationInfo>>

/** Seed the real SPEC_BUCKET with the three build artifacts and reset the cache. */
export async function seedSpec(
  paths: SpecPaths,
  products: string[] = ['workers'],
  tools: McpTool[] = []
): Promise<void> {
  await env.SPEC_BUCKET.put('spec.json', JSON.stringify({ paths }))
  await env.SPEC_BUCKET.put('products.json', JSON.stringify(products))
  await env.SPEC_BUCKET.put('mcp-tools.json', JSON.stringify({ version: 1, tools }))
  resetIsolateCache()
}

/** Wipe the spec bucket and the in-isolate cache. Call in afterEach. */
export async function clearSpec(): Promise<void> {
  await clearR2(env.SPEC_BUCKET)
  resetIsolateCache()
}

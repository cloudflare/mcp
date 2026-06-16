import { env } from 'cloudflare:workers'
import { buildNonCodemodeTools, zodInputSchemaFromJson } from './openapi'
import type { JsonObjectSchema, NonCodemodeTool, OperationInfo } from './openapi'
import type { z } from 'zod'

/**
 * In-isolate cache for the R2 spec artifacts (`spec.json`, `products.json`,
 * `non-codemode-tools.json`).
 *
 * The MCP worker isolate stays warm across requests, so without this every
 * search/execute/non-codemode call re-fetched the spec from R2. The scheduled
 * handler rewrites the artifacts at most daily, so a short TTL keeps a warm
 * isolate from serving a stale spec for long after an update while still
 * absorbing the vast majority of reads.
 */

const TTL_MS = 60 * 60 * 1000 // 1 hour

type SpecPaths = Record<string, Record<string, OperationInfo>>

type Entry<T> = { value: T; expiresAt: number }

let specEntry: Entry<{ text: string; paths: SpecPaths }> | undefined
let productsEntry: Entry<string[]> | undefined
let nonCodemodeToolsEntry: Entry<NonCodemodeTool[]> | undefined
let zodSchemas = new WeakMap<JsonObjectSchema, Record<string, z.ZodTypeAny>>()

function fresh<T>(entry: Entry<T> | undefined, now: number): entry is Entry<T> {
  return entry !== undefined && entry.expiresAt > now
}

/**
 * The raw `spec.json` text (for embedding into the search isolate) and its
 * parsed `paths` (for the non-codemode rollout fallback). Cached together so
 * both shapes come from a single R2 read. Throws if the spec has not been seeded.
 */
export async function getSpec(): Promise<{ text: string; paths: SpecPaths }> {
  const now = Date.now()
  if (fresh(specEntry, now)) return specEntry.value

  const obj = await env.SPEC_BUCKET.get('spec.json')
  if (!obj) throw new Error('spec.json not found in R2. Run the scheduled handler to populate it.')
  const text = await obj.text()
  const paths = (JSON.parse(text) as { paths: SpecPaths }).paths

  const value = { text, paths }
  specEntry = { value, expiresAt: now + TTL_MS }
  return value
}

/**
 * Protocol-ready non-Code-Mode tools/list artifact. Falls back to deriving it
 * from spec.json during a rolling deploy before the scheduled task/seed script
 * has written the new object.
 */
export async function getNonCodemodeTools(): Promise<NonCodemodeTool[]> {
  const now = Date.now()
  if (fresh(nonCodemodeToolsEntry, now)) return nonCodemodeToolsEntry.value

  const obj = await env.SPEC_BUCKET.get('non-codemode-tools.json')
  const value = obj
    ? ((await obj.json()) as NonCodemodeTool[])
    : buildNonCodemodeTools((await getSpec()).paths)
  nonCodemodeToolsEntry = { value, expiresAt: now + TTL_MS }
  return value
}

/**
 * Rehydrate each precomputed JSON Schema into Zod once per artifact revision.
 * Callers shallow-copy the returned shape before account-specific mutations.
 */
export function getZodInputSchema(schema: JsonObjectSchema): Record<string, z.ZodTypeAny> {
  let cached = zodSchemas.get(schema)
  if (!cached) {
    cached = zodInputSchemaFromJson(schema)
    zodSchemas.set(schema, cached)
  }
  return cached
}

/** The product list backing the `search` tool description. Empty if unseeded. */
export async function getProducts(): Promise<string[]> {
  const now = Date.now()
  if (fresh(productsEntry, now)) return productsEntry.value

  const obj = await env.SPEC_BUCKET.get('products.json')
  const value: string[] = obj ? await obj.json() : []
  productsEntry = { value, expiresAt: now + TTL_MS }
  return value
}

/** Drop cached artifacts. For tests that re-seed R2 between cases. */
export function resetIsolateCache(): void {
  specEntry = undefined
  productsEntry = undefined
  nonCodemodeToolsEntry = undefined
  zodSchemas = new WeakMap()
}

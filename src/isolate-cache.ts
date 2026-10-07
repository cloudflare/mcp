import { env } from 'cloudflare:workers'
import type { Tool } from '@modelcontextprotocol/server'
import {
  MCP_TOOLS_KEY,
  PRODUCTS_KEY,
  SPEC_KEY,
  unpackTools,
  type McpTool,
  type McpToolsArtifact
} from './mcp-tools'
import type { OperationInfo } from './openapi'

/**
 * In-isolate cache for the R2 artifacts the daily ToolsBuilder run writes
 * (`spec.json`, `products.json`, `mcp-tools.json`).
 *
 * The MCP worker isolate stays warm across requests, so without this every
 * call re-read R2. The artifacts change at most daily, so a short TTL keeps a
 * warm isolate from serving stale data for long after an update while still
 * absorbing nearly all reads.
 */

const TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * How long a request waits on a load another request started before loading
 * for itself. A load is I/O owned by the request that began it; if that
 * request is cancelled, the shared promise may never settle.
 */
const SHARED_LOAD_WAIT_MS = 15_000

/**
 * A once-per-isolate value with a TTL. Concurrent requests on a cold isolate
 * share one load instead of each parsing a multi-megabyte artifact, which
 * could exceed the isolate's memory. A failed load is not cached.
 */
function cached<T>(load: () => Promise<T>) {
  let entry: { promise: Promise<T>; expiresAt: number; settled: boolean } | undefined
  const start = (now: number) => {
    const promise = load()
    const current = { promise, expiresAt: now + TTL_MS, settled: false }
    entry = current
    promise.then(
      () => {
        current.settled = true
      },
      () => {
        if (entry === current) entry = undefined
      }
    )
    return promise
  }
  return {
    get(): Promise<T> {
      const now = Date.now()
      if (!entry || entry.expiresAt <= now) return start(now)
      if (entry.settled) return entry.promise
      const shared = entry.promise
      let timer: ReturnType<typeof setTimeout> | undefined
      const fallback = new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => load().then(resolve, reject), SHARED_LOAD_WAIT_MS)
      })
      return Promise.race([shared, fallback]).finally(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
    },
    reset() {
      entry = undefined
    }
  }
}

/**
 * `mcp-tools.json` ready to serve: a `tools/list` payload for each protocol
 * era, built once per isolate, and a name lookup for `tools/call`.
 */
export interface DirectTools {
  /** 2025-era clients: no `outputSchema` (its root must be an object there). */
  list: Tool[]
  /** 2026-07-28 clients: with each tool's `outputSchema`. */
  modernList: Tool[]
  byName: Map<string, McpTool>
}

type SpecPaths = Record<string, Record<string, OperationInfo>>

async function required(key: string): Promise<R2ObjectBody> {
  const object = await env.SPEC_BUCKET.get(key)
  if (!object) throw new Error(`${key} not found in R2. Run the scheduled ToolsBuilder build.`)
  return object
}

const spec = cached(async () => (await required(SPEC_KEY)).text())

/** The raw `spec.json` text, embedded into the search isolate. */
export function getSpec(): Promise<string> {
  return spec.get()
}

let specPaths: { text: string; paths: SpecPaths } | undefined

/**
 * `spec.json` paths, parsed only when needed (explaining a refused `execute`
 * request) and reused until the cached text changes.
 */
export async function getSpecPaths(): Promise<SpecPaths> {
  const text = await getSpec()
  if (specPaths?.text !== text) {
    specPaths = { text, paths: (JSON.parse(text) as { paths: SpecPaths }).paths }
  }
  return specPaths.paths
}

const directTools = cached(async (): Promise<DirectTools> => {
  const tools = unpackTools((await (await required(MCP_TOOLS_KEY)).json()) as McpToolsArtifact)
  const list: Tool[] = tools.map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    ...(title ? { title } : {}),
    description,
    // Generated JSON Schema; the SDK types it as a JSON value tree.
    inputSchema: inputSchema as unknown as Tool['inputSchema'],
    annotations
  }))
  return {
    list,
    modernList: tools.map(({ outputSchema }, index) =>
      outputSchema === undefined
        ? list[index]!
        : { ...list[index]!, outputSchema: outputSchema as unknown as Tool['outputSchema'] }
    ),
    byName: new Map(tools.map((tool) => [tool.name, tool]))
  }
})

/** The direct tools, served exactly as generated. */
export function getDirectTools(): Promise<DirectTools> {
  return directTools.get()
}

const products = cached(async (): Promise<string[]> => {
  const object = await env.SPEC_BUCKET.get(PRODUCTS_KEY)
  return object ? object.json() : []
})

/** The product list backing the `search` tool description. Empty if unseeded. */
export function getProducts(): Promise<string[]> {
  return products.get()
}

/** Drop cached artifacts. For tests that re-seed R2 between cases. */
export function resetIsolateCache(): void {
  spec.reset()
  specPaths = undefined
  products.reset()
  directTools.reset()
}

import { env } from 'cloudflare:workers'
import type { Tool } from '@modelcontextprotocol/server'
import {
  MCP_TOOLS_KEY,
  PRODUCTS_KEY,
  SPEC_KEY,
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

type Entry<T> = { value: T; expiresAt: number }

/** `mcp-tools.json` ready to serve: the `tools/list` payload and a name lookup for `tools/call`. */
export interface DirectTools {
  list: Tool[]
  byName: Map<string, McpTool>
}

type SpecPaths = Record<string, Record<string, OperationInfo>>

let specEntry: Entry<string> | undefined
let specPaths: { text: string; paths: SpecPaths } | undefined
let productsEntry: Entry<string[]> | undefined
let toolsEntry: Entry<DirectTools> | undefined

function fresh<T>(entry: Entry<T> | undefined, now: number): entry is Entry<T> {
  return entry !== undefined && entry.expiresAt > now
}

async function required(key: string): Promise<R2ObjectBody> {
  const object = await env.SPEC_BUCKET.get(key)
  if (!object) throw new Error(`${key} not found in R2. Run the scheduled ToolsBuilder build.`)
  return object
}

/** The raw `spec.json` text, embedded into the search isolate. */
export async function getSpec(): Promise<string> {
  const now = Date.now()
  if (fresh(specEntry, now)) return specEntry.value

  const value = await (await required(SPEC_KEY)).text()
  specEntry = { value, expiresAt: now + TTL_MS }
  return value
}

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

/** The direct tools, served exactly as generated. */
export async function getDirectTools(): Promise<DirectTools> {
  const now = Date.now()
  if (fresh(toolsEntry, now)) return toolsEntry.value

  const { tools } = (await (await required(MCP_TOOLS_KEY)).json()) as McpToolsArtifact
  const value: DirectTools = {
    list: tools.map(({ name, title, description, inputSchema, annotations }) => ({
      name,
      ...(title ? { title } : {}),
      description,
      // Generated JSON Schema; the SDK types it as a JSON value tree.
      inputSchema: inputSchema as unknown as Tool['inputSchema'],
      annotations
    })),
    byName: new Map(tools.map((tool) => [tool.name, tool]))
  }
  toolsEntry = { value, expiresAt: now + TTL_MS }
  return value
}

/** The product list backing the `search` tool description. Empty if unseeded. */
export async function getProducts(): Promise<string[]> {
  const now = Date.now()
  if (fresh(productsEntry, now)) return productsEntry.value

  const object = await env.SPEC_BUCKET.get(PRODUCTS_KEY)
  const value: string[] = object ? await object.json() : []
  productsEntry = { value, expiresAt: now + TTL_MS }
  return value
}

/** Drop cached artifacts. For tests that re-seed R2 between cases. */
export function resetIsolateCache(): void {
  specEntry = undefined
  specPaths = undefined
  productsEntry = undefined
  toolsEntry = undefined
}

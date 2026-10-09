import { env } from 'cloudflare:workers'
import type { Tool } from '@modelcontextprotocol/server'
import { MCP_TOOLS_KEY, type McpTool } from './openapi'
import { SKILLS_BUNDLE_KEY, SkillsBundle, type Skill, type SkillFile } from './skills/types'

/**
 * In-isolate cache for the R2 artifacts the scheduled handler writes
 * (`spec.json`, `products.json`, `mcp-tools.json`, `skills.json`).
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

async function required(key: string): Promise<R2ObjectBody> {
  const object = await env.SPEC_BUCKET.get(key)
  if (!object) throw new Error(`${key} not found in R2. Run the scheduled handler to populate it.`)
  return object
}

const spec = cached(async () => (await required('spec.json')).text())

/** The raw `spec.json` text, embedded into the search isolate. */
export function getSpec(): Promise<string> {
  return spec.get()
}

/**
 * `mcp-tools.json` ready to serve: the `tools/list` payload, built once per
 * isolate, and a name lookup for `tools/call`.
 */
export interface McpTools {
  list: Tool[]
  byName: Map<string, McpTool>
}

const mcpTools = cached(async (): Promise<McpTools> => {
  const tools = (await (await required(MCP_TOOLS_KEY)).json()) as McpTool[]
  return {
    list: tools.map(({ name, title, description, inputSchema }) => ({
      name,
      ...(title ? { title } : {}),
      description,
      inputSchema
    })),
    byName: new Map(tools.map((tool) => [tool.name, tool]))
  }
})

/** The direct tools, served exactly as the scheduled handler generated them. */
export function getMcpTools(): Promise<McpTools> {
  return mcpTools.get()
}

const products = cached(async (): Promise<string[]> => {
  const object = await env.SPEC_BUCKET.get('products.json')
  return object ? object.json() : []
})

/** The product list backing the `search` tool description. Empty if unseeded. */
export function getProducts(): Promise<string[]> {
  return products.get()
}

/** The synced skills, indexed for `skills/get` and `resources/read`. */
export interface SkillsIndex {
  readonly skills: readonly Skill[]
  readonly skillsByUri: ReadonlyMap<string, Skill>
  readonly filesByUri: ReadonlyMap<string, SkillFile>
}

const skills = cached(async (): Promise<SkillsIndex> => {
  const object = await env.SPEC_BUCKET.get(SKILLS_BUNDLE_KEY)
  const entries = object ? SkillsBundle.parse(await object.json()).skills : []
  return {
    skills: entries.map((entry) => entry.skill),
    skillsByUri: new Map(entries.map((entry) => [entry.skill.uri, entry.skill])),
    filesByUri: new Map(entries.flatMap((entry) => entry.files.map((file) => [file.uri, file])))
  }
})

/**
 * The skills bundle written by the daily sync. Empty until the first sync,
 * which the Skills extension allows: hosts must not read an empty listing as
 * proof that a server has no skills.
 */
export function getSkills(): Promise<SkillsIndex> {
  return skills.get()
}

/** Drop cached artifacts. For tests that re-seed R2 between cases. */
export function resetIsolateCache(): void {
  spec.reset()
  products.reset()
  mcpTools.reset()
  skills.reset()
}

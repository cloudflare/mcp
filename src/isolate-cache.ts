import { env } from 'cloudflare:workers'
import { isolate } from './lib/isolate'
import type { Tool } from '@modelcontextprotocol/server'
import type { McpTool } from './openapi'
import type { SpecArtifactName } from './spec-release'
import {
  SKILLS_MANIFEST_KEY,
  SkillsManifest,
  skillFileKey,
  type Skill,
  type SkillFile
} from './skills/types'

/**
 * In-isolate cache for what the forge tools service serves (the pinned spec's
 * artifacts, `spec.json`, `products.json` and `mcp-tools.json`, and the tool
 * list) and the skills the scheduled handler writes to R2 (the manifest and
 * files).
 *
 * The MCP worker isolate stays warm across requests, so without this every
 * call re-read them. The spec changes only with a deploy and the skills at
 * most every six hours, so a short TTL keeps a warm isolate from serving stale
 * data for long after an update while still absorbing nearly all reads.
 */

const TTL_MS = 60 * 60 * 1000 // 1 hour

/** An artifact loaded once per isolate and refreshed hourly. */
function artifact<T>(load: () => Promise<T>) {
  return isolate.value(load, { ttlMs: TTL_MS })
}

/** Reads one of the pinned spec's artifacts as text. */
export type SpecArtifactSource = (name: SpecArtifactName) => Promise<string>

/** The forge tools service, which ships the artifacts with the generated tools. */
const serviceSource: SpecArtifactSource = async (name) =>
  new Response(await env.FORGE_TOOLS.specArtifact(name)).text()

let specArtifactSource: SpecArtifactSource = serviceSource

/**
 * Reads the spec artifacts from `source`, or from the forge tools service again
 * without one, and empties the cache. For tests, which serve fixtures.
 */
export function setSpecArtifactSource(source?: SpecArtifactSource): void {
  specArtifactSource = source ?? serviceSource
  isolate.resetAll()
}

const spec = artifact(() => specArtifactSource('spec.json'))

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

const mcpTools = artifact(async (): Promise<McpTools> => {
  const tools = JSON.parse(await specArtifactSource('mcp-tools.json')) as McpTool[]
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

/** The direct tools, served exactly as `mcp-tools.json` lists them. */
export function getMcpTools(): Promise<McpTools> {
  return mcpTools.get()
}

const forgeToolList = artifact(
  async (): Promise<Tool[]> => JSON.parse(await env.FORGE_TOOLS.listJson()) as Tool[]
)

const forgeToolListWithOutput = artifact(
  async (): Promise<Tool[]> =>
    JSON.parse(await env.FORGE_TOOLS.listJson({ outputSchema: true })) as Tool[]
)

/**
 * The generated tools (`?codemode=false&experimentalForge=true`) as
 * `tools/list` sends them, from the forge tools service. The service sends one
 * JSON string, which is parsed here once per isolate: decoding ~3,000 nested
 * objects over RPC costs every `tools/list` hundreds of milliseconds of CPU.
 *
 * @param outputSchema - Include each tool's generated output schema, a
 *   separate listing that is loaded only when asked for.
 */
export function getForgeToolList({ outputSchema = false } = {}): Promise<Tool[]> {
  return outputSchema ? forgeToolListWithOutput.get() : forgeToolList.get()
}

const products = artifact(
  async (): Promise<string[]> => JSON.parse(await specArtifactSource('products.json')) as string[]
)

/** The product list backing the `search` tool description. */
export function getProducts(): Promise<string[]> {
  return products.get()
}

/** The synced skills, indexed for `skills/get` and `resources/read`. */
export interface SkillsIndex {
  readonly skills: readonly Skill[]
  readonly skillsByUri: ReadonlyMap<string, Skill>
  readonly filesByUri: ReadonlyMap<string, SkillFile>
}

const skills = artifact(async (): Promise<SkillsIndex> => {
  const object = await env.SPEC_BUCKET.get(SKILLS_MANIFEST_KEY)
  const entries = object ? SkillsManifest.parse(await object.json()).skills : []
  return {
    skills: entries.map((entry) => entry.skill),
    skillsByUri: new Map(entries.map((entry) => [entry.skill.uri, entry.skill])),
    filesByUri: new Map(entries.flatMap((entry) => entry.files.map((file) => [file.uri, file])))
  }
})

/**
 * The skills manifest written by the sync. Empty until the first sync,
 * which the Skills extension allows: hosts must not read an empty listing as
 * proof that a server has no skills.
 */
export function getSkills(): Promise<SkillsIndex> {
  return skills.get()
}

/**
 * Skill file bytes by R2 key. Files are content-addressed and never change, so
 * they need no TTL; the cap only bounds memory. The whole catalog is a few MB.
 */
const skillFileBytes = isolate.map<string, Uint8Array>({
  maxSize: 16 * 1024 * 1024,
  sizeOf: (bytes) => bytes.byteLength
})

/**
 * The bytes of one skill file, which always match `file.digest`.
 *
 * @throws If R2 no longer holds them, which only happens when a manifest
 *   cached here is older than the sync's retention window.
 */
export async function readSkillFile(file: SkillFile): Promise<Uint8Array> {
  const key = skillFileKey(file.digest)
  const hit = skillFileBytes.get(key)
  if (hit) return hit

  const object = await env.SPEC_BUCKET.get(key)
  if (!object) {
    skills.reset()
    throw new Error(`Skill file ${file.uri} is missing from R2; reload the skill entry`)
  }
  return skillFileBytes.set(key, new Uint8Array(await object.arrayBuffer()))
}

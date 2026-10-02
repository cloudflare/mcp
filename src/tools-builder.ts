import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'
// Bundled from scripts/generator/cli.ts by `npm run build:generator`.
import GENERATOR_SOURCE from '../generated/tools-generator.mjs.txt'

/** R2 key of the Forge-generated non-Code-Mode tool artifact. */
export const MCP_TOOLS_KEY = 'mcp-tools.json'
export const FORGE_RELEASES_URL =
  'https://api.github.com/repos/cloudflare/forge/releases?per_page=20'
const RELEASE_PREFIX = 'openapi@'
const SOURCE_ASSET = 'openapi.forge.json'
const USER_AGENT = 'cloudflare-mcp-tools-builder'
/** Cloudflare-managed image (Debian Trixie slim + Node.js 24); no image build or push. */
const GENERATOR_IMAGE = 'cloudflare/debian-trixie'
const GENERATOR_PATH = '/tmp/generate.mjs'
const INSTALL_COMMAND = ['sh', '-c', `cat > ${GENERATOR_PATH}`]
const GENERATOR_COMMAND = ['node', '--max-old-space-size=3072', GENERATOR_PATH]
const GENERATOR_TIMEOUT_MS = 5 * 60 * 1000
const BUILD_INSTANCE = 'daily'

const Releases = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    assets: z.array(z.object({ name: z.string(), browser_download_url: z.url() }))
  })
)

// Structural check only: the generator's own tests cover tool contents.
const Artifact = z.object({
  version: z.literal(1),
  tools: z.array(z.object({ name: z.string() })).min(1)
})

/** The Forge release a build was generated from. */
export interface ForgeRelease {
  tag: string
  sourceUrl: string
}

export interface BuildResult {
  release: string
  tools: number
  bytes: number
}

/** Runs the generator on a Forge document and returns mcp-tools.json. */
export interface ToolsGenerator {
  generate(source: ReadableStream<Uint8Array>): Promise<string>
}

export type BuildDependencies = Readonly<{
  fetch: typeof fetch
  generator: ToolsGenerator
  bucket: Pick<R2Bucket, 'put'>
}>

async function get(fetcher: typeof fetch, url: string, accept: string): Promise<Response> {
  const response = await fetcher(url, { headers: { accept, 'user-agent': USER_AGENT } })
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`)
  return response
}

/** Find the newest published Forge OpenAPI release carrying the bundled document. */
export async function latestForgeRelease(fetcher: typeof fetch): Promise<ForgeRelease> {
  const response = await get(fetcher, FORGE_RELEASES_URL, 'application/vnd.github+json')
  for (const release of Releases.parse(await response.json())) {
    if (release.draft || release.prerelease || !release.tag_name.startsWith(RELEASE_PREFIX))
      continue
    const asset = release.assets.find(({ name }) => name === SOURCE_ASSET)
    if (asset) return { tag: release.tag_name, sourceUrl: asset.browser_download_url }
  }
  throw new Error(`No ${RELEASE_PREFIX}* release with ${SOURCE_ASSET}`)
}

/**
 * Generate mcp-tools.json from the latest Forge release and store it in R2.
 * Nothing is written unless generation and validation succeed, so a failed
 * build keeps the previous artifact.
 */
export async function buildMcpTools(dependencies: BuildDependencies): Promise<BuildResult> {
  const release = await latestForgeRelease(dependencies.fetch)
  const source = await get(dependencies.fetch, release.sourceUrl, 'application/octet-stream')
  if (!source.body) throw new Error(`GET ${release.sourceUrl} returned no body`)
  const content = await dependencies.generator.generate(source.body)

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(`Generator output for ${release.tag} is not JSON`)
  }
  const artifact = Artifact.safeParse(parsed)
  if (!artifact.success) {
    throw new Error(`Invalid artifact for ${release.tag}: ${artifact.error.message}`)
  }

  await dependencies.bucket.put(MCP_TOOLS_KEY, content, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { forgeRelease: release.tag, tools: String(artifact.data.tools.length) }
  })
  return {
    release: release.tag,
    tools: artifact.data.tools.length,
    bytes: new TextEncoder().encode(content).byteLength
  }
}

/**
 * Runs the bundled generator in the managed image with no network access. The
 * bundle is written into the container, the Forge document goes in on stdin,
 * and the artifact comes back on stdout. The container never sees credentials
 * or bindings. Each run starts a fresh container and destroys it.
 */
export class ContainerToolsGenerator implements ToolsGenerator {
  constructor(private readonly container: Container) {}

  async generate(source: ReadableStream<Uint8Array>): Promise<string> {
    const container = this.container
    // A container left over from an interrupted run would reject start().
    if (container.running) await container.destroy()
    container.start({
      image: GENERATOR_IMAGE,
      instance: 'standard-1',
      enableInternet: false,
      entrypoint: ['/bin/sleep', 'infinity']
    })
    const stopped = container.monitor().catch(() => undefined)

    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), GENERATOR_TIMEOUT_MS)
    try {
      await run(container, INSTALL_COMMAND, new Response(GENERATOR_SOURCE).body!, abort.signal)
      // Buffer the document (~27 MB) first: piping the network stream straight into
      // exec() stdin after an earlier exec() stalled until the timeout under wrangler dev.
      const document = await new Response(source).arrayBuffer()
      return await run(container, GENERATOR_COMMAND, new Response(document).body!, abort.signal)
    } finally {
      clearTimeout(timeout)
      await container.destroy()
      await stopped
    }
  }
}

/** Run one process to completion and return its stdout, or throw with its stderr. */
async function run(
  container: Container,
  command: string[],
  stdin: ReadableStream,
  signal: AbortSignal
): Promise<string> {
  const process = await container.exec(command, { stdin, signal })
  const { stdout, stderr, exitCode } = await process.output()
  if (exitCode !== 0) {
    const detail = new TextDecoder().decode(stderr).trim().slice(-2000)
    const timedOut = signal.aborted ? ' (timed out)' : ''
    throw new Error(`${command.join(' ')} exited with ${exitCode}${timedOut}: ${detail}`)
  }
  return new TextDecoder().decode(stdout)
}

/** Owns the generator container; one named instance runs the daily build. */
export class ToolsBuilder extends DurableObject<Env> {
  async build(): Promise<BuildResult> {
    const container = this.ctx.container
    if (!container) throw new Error('ToolsBuilder has no container configured')
    return buildMcpTools({
      fetch: (input, init) => fetch(input, init),
      generator: new ContainerToolsGenerator(container),
      bucket: this.env.SPEC_BUCKET
    })
  }
}

/** Scheduled entrypoint: run one build and fail the cron invocation on error. */
export async function runMcpToolsBuild(
  namespace: DurableObjectNamespace<ToolsBuilder>
): Promise<void> {
  const result = await namespace.getByName(BUILD_INSTANCE).build()
  console.log(`Stored ${result.tools} MCP tools (${result.bytes} bytes) from ${result.release}`)
}

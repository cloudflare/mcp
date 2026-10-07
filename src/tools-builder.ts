import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'
// Bundled from scripts/generator/cli.ts by `npm run build:generator`.
import GENERATOR_SOURCE from '../generated/tools-generator.mjs.txt'
import { latestForgeSpec } from './forge-source'
import { ARTIFACT_KEYS, type ArtifactKey } from './mcp-tools'

/** Hostnames the container can reach. Both are answered by `BuildEgress`. */
export const FORGE_HOST = 'forge.internal'
export const ARTIFACTS_HOST = 'artifacts.internal'

/** Cloudflare-managed image (Debian Trixie slim + Node.js 24); no image build or push. */
const GENERATOR_IMAGE = 'cloudflare/debian-trixie'
const GENERATOR_COMMAND = ['node', '--max-old-space-size=3072', '--input-type=module', '-']
const GENERATOR_TIMEOUT_MS = 5 * 60 * 1000

/**
 * The container's only way out. `GET forge.internal/openapi.forge.json` returns
 * the newest Forge document; `PUT artifacts.internal/<key>` stores one of the
 * artifacts the Worker serves. Everything else is refused.
 */
export class BuildEgress extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const key = url.pathname.slice(1)

    if (url.hostname === FORGE_HOST && request.method === 'GET' && key === 'openapi.forge.json') {
      return latestForgeSpec(fetch)
    }
    if (url.hostname === ARTIFACTS_HOST && request.method === 'PUT' && isArtifactKey(key)) {
      await this.env.SPEC_BUCKET.put(key, request.body, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { forgeRelease: request.headers.get('x-forge-release') ?? 'unknown' }
      })
      return new Response(null, { status: 204 })
    }
    return new Response('Forbidden', { status: 403 })
  }
}

function isArtifactKey(key: string): key is ArtifactKey {
  return (ARTIFACT_KEYS as readonly string[]).includes(key)
}

/**
 * Runs the generator in a fresh container with no internet access. The
 * generator downloads Forge and uploads the artifacts through `BuildEgress`,
 * so the Durable Object only starts it, waits and tears it down.
 */
export class ToolsBuilder extends DurableObject<Env> {
  #running: Promise<string> | undefined

  /** Run one build. A call while a build is running joins it rather than replacing its container. */
  build(): Promise<string> {
    this.#running ??= this.run().finally(() => {
      this.#running = undefined
    })
    return this.#running
  }

  private async run(): Promise<string> {
    const container = this.ctx.container
    if (!container) throw new Error('ToolsBuilder has no container configured')
    // A container left over from an interrupted run would reject start().
    if (container.running) await container.destroy()

    container.start({
      image: GENERATOR_IMAGE,
      instance: 'standard-1',
      enableInternet: false,
      entrypoint: ['/bin/sleep', 'infinity']
    })
    const stopped = container.monitor().catch(() => undefined)
    try {
      const egress = this.ctx.exports.BuildEgress({ props: {} })
      await container.interceptOutboundHttp(FORGE_HOST, egress)
      await container.interceptOutboundHttp(ARTIFACTS_HOST, egress)

      const signal = AbortSignal.timeout(GENERATOR_TIMEOUT_MS)
      const stdin = new Response(GENERATOR_SOURCE).body!
      const process = await container.exec(GENERATOR_COMMAND, { stdin, signal })
      const { stdout, stderr, exitCode } = await process.output()
      if (exitCode !== 0) {
        const detail = new TextDecoder().decode(stderr).trim().slice(-2000)
        throw new Error(
          `Generator exited with ${exitCode}${signal.aborted ? ' (timed out)' : ''}: ${detail}`
        )
      }
      return new TextDecoder().decode(stdout).trim()
    } finally {
      await container.destroy()
      await stopped
    }
  }
}

import { env } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { clearR2 } from './helpers/r2'
import { server } from './setup/msw'
import {
  FORGE_RELEASES_URL,
  MCP_TOOLS_KEY,
  buildMcpTools,
  type ToolsGenerator
} from '../src/tools-builder'

/**
 * The GitHub release API and asset download are mocked with MSW; R2 is the
 * real SPEC_BUCKET binding. The container is replaced by a ToolsGenerator
 * fake because the workers pool does not run containers.
 */

const SOURCE_URL = 'https://assets.test/openapi.forge.json'
const SOURCE = { openapi: '3.0.3', paths: {} }
const ARTIFACT = JSON.stringify({ version: 1, tools: [{ name: 'workers_scripts_list' }] })

function release(tag: string, url = SOURCE_URL, options: { draft?: boolean } = {}) {
  return {
    tag_name: tag,
    draft: options.draft ?? false,
    prerelease: false,
    assets: [{ name: 'openapi.forge.json', browser_download_url: url }]
  }
}

function serveRelease(releases: unknown[]) {
  server.use(
    http.get(FORGE_RELEASES_URL.split('?')[0]!, () => HttpResponse.json(releases)),
    http.get(SOURCE_URL, () => HttpResponse.json(SOURCE))
  )
}

/** Records the document it receives and returns a fixed artifact. */
function generator(output: string): ToolsGenerator & { inputs: string[] } {
  const inputs: string[] = []
  return {
    inputs,
    async generate(source) {
      inputs.push(await new Response(source).text())
      return output
    }
  }
}

function build(tools: ToolsGenerator) {
  return buildMcpTools({ fetch, generator: tools, bucket: env.SPEC_BUCKET })
}

afterEach(() => clearR2(env.SPEC_BUCKET))

describe('buildMcpTools', () => {
  it('generates from the newest published openapi release and stores it in R2', async () => {
    serveRelease([
      release('openapi@draft', 'https://assets.test/draft', { draft: true }),
      { tag_name: 'v1.0.0', draft: false, prerelease: false, assets: [] },
      release('openapi@new'),
      release('openapi@old', 'https://assets.test/old')
    ])
    const tools = generator(ARTIFACT)

    const result = await build(tools)

    expect(result).toEqual({ release: 'openapi@new', tools: 1, bytes: ARTIFACT.length })
    expect(tools.inputs.map((input) => JSON.parse(input))).toEqual([SOURCE])
    const object = await env.SPEC_BUCKET.get(MCP_TOOLS_KEY)
    expect(await object!.text()).toBe(ARTIFACT)
    expect(object!.httpMetadata?.contentType).toBe('application/json')
    expect(object!.customMetadata).toEqual({ forgeRelease: 'openapi@new', tools: '1' })
  })

  it.each([
    ['non-JSON output', 'nope', 'is not JSON'],
    ['an empty tool list', JSON.stringify({ version: 1, tools: [] }), 'Invalid artifact'],
    [
      'an unknown version',
      JSON.stringify({ version: 2, tools: [{ name: 'x' }] }),
      'Invalid artifact'
    ]
  ])('rejects %s and keeps the previous artifact', async (_, output, message) => {
    serveRelease([release('openapi@new')])
    await env.SPEC_BUCKET.put(MCP_TOOLS_KEY, 'previous')

    await expect(build(generator(output))).rejects.toThrow(message)

    expect(await (await env.SPEC_BUCKET.get(MCP_TOOLS_KEY))!.text()).toBe('previous')
  })

  it('keeps the previous artifact when the generator fails', async () => {
    serveRelease([release('openapi@new')])
    await env.SPEC_BUCKET.put(MCP_TOOLS_KEY, 'previous')
    const failing: ToolsGenerator = {
      generate: () => Promise.reject(new Error('Generator exited with 1: boom'))
    }

    await expect(build(failing)).rejects.toThrow('Generator exited with 1: boom')

    expect(await (await env.SPEC_BUCKET.get(MCP_TOOLS_KEY))!.text()).toBe('previous')
  })

  it('does not run the generator when the source download fails', async () => {
    server.use(
      http.get(FORGE_RELEASES_URL.split('?')[0]!, () =>
        HttpResponse.json([release('openapi@new')])
      ),
      http.get(SOURCE_URL, () => new HttpResponse('gone', { status: 502 }))
    )
    const tools = generator(ARTIFACT)

    await expect(build(tools)).rejects.toThrow(`GET ${SOURCE_URL} failed: 502`)

    expect(tools.inputs).toEqual([])
    expect(await env.SPEC_BUCKET.get(MCP_TOOLS_KEY)).toBeNull()
  })

  it('fails when no release carries the Forge document', async () => {
    serveRelease([{ tag_name: 'v1.0.0', draft: false, prerelease: false, assets: [] }])

    await expect(build(generator(ARTIFACT))).rejects.toThrow('No openapi@* release')
  })
})

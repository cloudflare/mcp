import { env } from 'cloudflare:workers'
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext
} from 'cloudflare:test'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearR2 } from './helpers/r2'
import { mockSkillsArchive, skillMarkdown } from './helpers/skills'
import { SKILLS_ARCHIVE_URL } from '../src/skills/sync'
import { SKILLS_MANIFEST_KEY, SkillsManifest } from '../src/skills/types'
import { server } from './setup/msw'
import worker from '../src/index'

/**
 * Integration tests for the scheduled() handler. The GitHub spec and skills
 * downloads are the only mocked boundaries (MSW); the R2 bucket is the REAL `env.SPEC_BUCKET`
 * binding, asserted by reading objects back out. Drives the handler with real
 * ScheduledController / ExecutionContext instances.
 */

const RELEASE_URL = `https://api.github.com/repos/${env.OPENAPI_SPEC_REPO}/releases/latest`
const ASSET_URL = `https://api.github.com/repos/${env.OPENAPI_SPEC_REPO}/releases/assets/1`
const DOWNLOAD_URL = 'https://release-assets.githubusercontent.com/openapi.forge.json'

/**
 * Serve `spec` as the latest release's `openapi.forge.json`, the way GitHub
 * does for a private repository: the asset URL takes the token and redirects
 * to a signed download URL, which refuses one.
 */
function mockSpecRelease(spec: Record<string, unknown>) {
  server.use(
    http.get(RELEASE_URL, ({ request }) =>
      request.headers.get('authorization') === `Bearer ${env.OPENAPI_SPEC_GITHUB_TOKEN}`
        ? HttpResponse.json({
            tag_name: 'openapi@test',
            assets: [{ name: 'openapi.forge.json', url: ASSET_URL }]
          })
        : new HttpResponse('Not Found', { status: 404 })
    ),
    http.get(
      ASSET_URL,
      () => new HttpResponse(null, { status: 302, headers: { Location: DOWNLOAD_URL } })
    ),
    http.get(DOWNLOAD_URL, ({ request }) =>
      request.headers.has('authorization')
        ? new HttpResponse('Only one auth mechanism allowed', { status: 400 })
        : HttpResponse.json(spec)
    )
  )
}

const RAW_SPEC = {
  openapi: '3.0.0',
  info: { title: 'Test', version: '1.0' },
  paths: {
    '/accounts/{account_id}/workers/scripts': {
      get: {
        summary: 'List Workers',
        tags: ['Workers Scripts'],
        parameters: [],
        responses: { '200': { description: 'OK' } }
      }
    }
  }
}

async function runScheduled() {
  const controller = createScheduledController({ scheduledTime: Date.now(), cron: '0 */6 * * *' })
  const ctx = createExecutionContext()
  await worker.scheduled!(controller, env, ctx)
  await waitOnExecutionContext(ctx)
}

afterEach(() => clearR2(env.SPEC_BUCKET))

describe('scheduled handler', () => {
  beforeEach(() =>
    mockSkillsArchive({ 'skills/wrangler/SKILL.md': skillMarkdown('wrangler', 'Use Wrangler') })
  )

  it('fetches the spec from GitHub, processes it, and writes spec, products and mcp-tools.json to real R2', async () => {
    mockSpecRelease(RAW_SPEC)

    await runScheduled()

    // Read the real bucket back out.
    const specObj = await env.SPEC_BUCKET.get('spec.json')
    const productsObj = await env.SPEC_BUCKET.get('products.json')
    const mcpToolsObj = await env.SPEC_BUCKET.get('mcp-tools.json')
    expect(specObj).not.toBeNull()
    expect(productsObj).not.toBeNull()
    expect(mcpToolsObj).not.toBeNull()

    const spec = (await specObj!.json()) as { paths: Record<string, unknown> }
    expect(spec.paths['/accounts/{account_id}/workers/scripts']).toBeDefined()

    const products = (await productsObj!.json()) as string[]
    expect(products).toContain('workers')

    const tools = (await mcpToolsObj!.json()) as Array<{
      name: string
      inputSchema: { properties?: Record<string, unknown>; required?: string[] }
    }>
    expect(tools).toEqual([
      expect.objectContaining({
        name: 'get_accounts_workers_scripts',
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            account_id: expect.objectContaining({
              description: expect.stringContaining('Optional when the session')
            })
          })
        })
      })
    ])
    // account_id is optional for every session, decided at build time.
    expect(tools[0].inputSchema.required).toBeUndefined()
  })

  it('throws and writes no spec artifacts when GitHub returns a non-2xx', async () => {
    server.use(http.get(RELEASE_URL, () => new HttpResponse('Not Found', { status: 404 })))

    await expect(runScheduled()).rejects.toThrow(
      `Failed to read the latest ${env.OPENAPI_SPEC_REPO} release: HTTP 404`
    )

    // No spec artifact was written; the independent skills sync still ran.
    for (const key of ['spec.json', 'products.json', 'mcp-tools.json']) {
      expect(await env.SPEC_BUCKET.get(key)).toBeNull()
    }
    expect(await env.SPEC_BUCKET.get(SKILLS_MANIFEST_KEY)).not.toBeNull()
  })

  it('syncs cloudflare/skills into R2 and records the source commit', async () => {
    mockSpecRelease(RAW_SPEC)

    await runScheduled()

    const object = await env.SPEC_BUCKET.get(SKILLS_MANIFEST_KEY)
    const manifest = SkillsManifest.parse(await object!.json())
    expect(manifest.source).toEqual({
      repository: 'cloudflare/skills',
      commit: 'a84b615ff9d40e7f99755aea23d65e52d645bd42'
    })
    expect(manifest.skills.map(({ skill }) => skill.uri)).toEqual(['skill://wrangler/SKILL.md'])
  })

  it('still updates the spec when the skills download fails, then reports the failure', async () => {
    mockSpecRelease(RAW_SPEC)
    server.use(http.get(SKILLS_ARCHIVE_URL, () => new HttpResponse('Bad Gateway', { status: 502 })))

    await expect(runScheduled()).rejects.toThrow('Failed to fetch skills archive: 502')

    expect(await env.SPEC_BUCKET.get('spec.json')).not.toBeNull()
    expect(await env.SPEC_BUCKET.get(SKILLS_MANIFEST_KEY)).toBeNull()
  })
})

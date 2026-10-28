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
import { SKILLS_ARCHIVE_URL, SKILLS_CRON } from '../src/skills/sync'
import { SPEC_RELEASE, SPEC_URL } from '../src/spec-release'
import { SKILLS_MANIFEST_KEY, SkillsManifest } from '../src/skills/types'
import { server } from './setup/msw'
import worker from '../src/index'

/**
 * Integration tests for the scheduled() handler. The GitHub spec and skills
 * downloads are the only mocked boundaries (MSW); the R2 bucket is the REAL `env.SPEC_BUCKET`
 * binding, asserted by reading objects back out. Drives the handler with real
 * ScheduledController / ExecutionContext instances.
 */

/** The cron that syncs the spec (`wrangler.jsonc`). */
const SPEC_CRON = '*/10 * * * *'

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

async function runScheduled(cron: string) {
  const controller = createScheduledController({ scheduledTime: Date.now(), cron })
  const ctx = createExecutionContext()
  await worker.scheduled!(controller, env, ctx)
  await waitOnExecutionContext(ctx)
}

afterEach(() => clearR2(env.SPEC_BUCKET))

describe('scheduled handler', () => {
  beforeEach(() =>
    mockSkillsArchive({ 'skills/wrangler/SKILL.md': skillMarkdown('wrangler', 'Use Wrangler') })
  )

  it('downloads the pinned release, not the latest', () => {
    expect(SPEC_RELEASE).toMatch(/^openapi@[0-9a-f]{40}$/)
    expect(SPEC_URL).toBe(
      `https://github.com/cloudflare/forge/releases/download/openapi%40${SPEC_RELEASE.slice('openapi@'.length)}/openapi.forge.json`
    )
  })

  it('writes the pinned spec, products and mcp-tools.json to real R2, naming the release', async () => {
    server.use(http.get(SPEC_URL, () => HttpResponse.json(RAW_SPEC)))

    await runScheduled(SPEC_CRON)

    // Read the real bucket back out.
    const specObj = await env.SPEC_BUCKET.get('spec.json')
    const productsObj = await env.SPEC_BUCKET.get('products.json')
    const mcpToolsObj = await env.SPEC_BUCKET.get('mcp-tools.json')
    expect(specObj).not.toBeNull()
    expect(productsObj).not.toBeNull()
    expect(mcpToolsObj).not.toBeNull()
    expect(specObj!.customMetadata).toEqual({ release: SPEC_RELEASE })

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
    // The spec cron leaves the skills alone.
    expect(await env.SPEC_BUCKET.get(SKILLS_MANIFEST_KEY)).toBeNull()
  })

  it('downloads nothing when R2 already holds the pinned release', async () => {
    let downloads = 0
    server.use(
      http.get(SPEC_URL, () => {
        downloads++
        return HttpResponse.json(RAW_SPEC)
      })
    )

    await runScheduled(SPEC_CRON)
    await runScheduled(SPEC_CRON)

    expect(downloads).toBe(1)
  })

  it('replaces artifacts from another release', async () => {
    await env.SPEC_BUCKET.put('spec.json', '{"paths":{}}', {
      customMetadata: { release: 'openapi@0000000000000000000000000000000000000000' }
    })
    server.use(http.get(SPEC_URL, () => HttpResponse.json(RAW_SPEC)))

    await runScheduled(SPEC_CRON)

    const specObj = await env.SPEC_BUCKET.get('spec.json')
    expect(specObj!.customMetadata).toEqual({ release: SPEC_RELEASE })
    const spec = (await specObj!.json()) as { paths: Record<string, unknown> }
    expect(spec.paths['/accounts/{account_id}/workers/scripts']).toBeDefined()
  })

  it('throws and writes no spec artifacts when GitHub returns a non-2xx', async () => {
    server.use(http.get(SPEC_URL, () => new HttpResponse('Not Found', { status: 404 })))

    await expect(runScheduled(SPEC_CRON)).rejects.toThrow(
      `Failed to fetch OpenAPI spec ${SPEC_RELEASE}: 404`
    )

    for (const key of ['spec.json', 'products.json', 'mcp-tools.json']) {
      expect(await env.SPEC_BUCKET.get(key)).toBeNull()
    }
  })

  it('syncs cloudflare/skills into R2 on the skills cron, without the spec', async () => {
    await runScheduled(SKILLS_CRON)

    const object = await env.SPEC_BUCKET.get(SKILLS_MANIFEST_KEY)
    const manifest = SkillsManifest.parse(await object!.json())
    expect(manifest.source).toEqual({
      repository: 'cloudflare/skills',
      commit: 'a84b615ff9d40e7f99755aea23d65e52d645bd42'
    })
    expect(manifest.skills.map(({ skill }) => skill.uri)).toEqual(['skill://wrangler/SKILL.md'])
    expect(await env.SPEC_BUCKET.get('spec.json')).toBeNull()
  })

  it('reports a failed skills download', async () => {
    server.use(http.get(SKILLS_ARCHIVE_URL, () => new HttpResponse('Bad Gateway', { status: 502 })))

    await expect(runScheduled(SKILLS_CRON)).rejects.toThrow('Failed to fetch skills archive: 502')

    expect(await env.SPEC_BUCKET.get(SKILLS_MANIFEST_KEY)).toBeNull()
  })
})

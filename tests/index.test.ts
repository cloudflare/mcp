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
 * Integration tests for the scheduled() handler, which syncs the skills. The
 * GitHub skills download is the only mocked boundary (MSW); the R2 bucket is the REAL `env.SPEC_BUCKET`
 * binding, asserted by reading objects back out. Drives the handler with real
 * ScheduledController / ExecutionContext instances.
 */

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

  it('syncs cloudflare/skills into R2 and records the source commit, without touching the spec', async () => {
    await runScheduled()

    const object = await env.SPEC_BUCKET.get(SKILLS_MANIFEST_KEY)
    const manifest = SkillsManifest.parse(await object!.json())
    expect(manifest.source).toEqual({
      repository: 'cloudflare/skills',
      commit: 'a84b615ff9d40e7f99755aea23d65e52d645bd42'
    })
    expect(manifest.skills.map(({ skill }) => skill.uri)).toEqual(['skill://wrangler/SKILL.md'])
    // The spec ships with the deploy, in the forge tools service.
    expect(await env.SPEC_BUCKET.get('spec.json')).toBeNull()
  })

  it('reports a failed skills download', async () => {
    server.use(http.get(SKILLS_ARCHIVE_URL, () => new HttpResponse('Bad Gateway', { status: 502 })))

    await expect(runScheduled()).rejects.toThrow('Failed to fetch skills archive: 502')

    expect(await env.SPEC_BUCKET.get(SKILLS_MANIFEST_KEY)).toBeNull()
  })
})

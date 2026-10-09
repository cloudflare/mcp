import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import { syncSkills } from '../../src/skills/sync'
import {
  SKILL_FILES_PREFIX,
  SKILLS_MANIFEST_KEY,
  SkillsManifest,
  skillFileKey
} from '../../src/skills/types'
import { clearR2 } from '../helpers/r2'
import { mockSkillsArchive, skillMarkdown } from '../helpers/skills'

/**
 * The incremental sync against the real R2 binding. The archive download is
 * the only mock.
 */

const WRANGLER = skillMarkdown('wrangler', 'Use Wrangler')
const DURABLE_OBJECTS = skillMarkdown('durable-objects', 'Build with Durable Objects')

async function storedFiles(): Promise<Map<string, string>> {
  const { objects } = await env.SPEC_BUCKET.list({ prefix: SKILL_FILES_PREFIX })
  return new Map(objects.map((object) => [object.key, object.etag]))
}

async function manifest(): Promise<SkillsManifest> {
  const object = await env.SPEC_BUCKET.get(SKILLS_MANIFEST_KEY)
  return SkillsManifest.parse(await object!.json())
}

function fileKey(current: SkillsManifest, uri: string): string {
  const file = current.skills.flatMap((entry) => entry.files).find((f) => f.uri === uri)
  if (!file) throw new Error(`${uri} is not in the manifest`)
  return skillFileKey(file.digest)
}

afterEach(() => clearR2(env.SPEC_BUCKET))

describe('syncSkills', () => {
  it('writes every file, then the manifest, on the first sync', async () => {
    await mockSkillsArchive({
      'skills/wrangler/SKILL.md': WRANGLER,
      'skills/wrangler/references/deploy.md': '# Deploy\n',
      'skills/durable-objects/SKILL.md': DURABLE_OBJECTS
    })

    const result = await syncSkills(env.SPEC_BUCKET)

    expect(result).toMatchObject({
      changed: true,
      changedSkills: ['durable-objects', 'wrangler'],
      filesWritten: 3,
      filesDeleted: 0
    })
    const current = await manifest()
    expect([...(await storedFiles()).keys()].sort()).toEqual(
      current.skills.flatMap((entry) => entry.files.map((file) => skillFileKey(file.digest))).sort()
    )
  })

  it('writes nothing when no skill changed', async () => {
    const files = { 'skills/wrangler/SKILL.md': WRANGLER, 'README.md': 'v1' }
    await mockSkillsArchive(files)
    await syncSkills(env.SPEC_BUCKET)
    const manifestEtag = (await env.SPEC_BUCKET.head(SKILLS_MANIFEST_KEY))?.etag

    // A repository change outside skills/ is not a skill change.
    await mockSkillsArchive({ ...files, 'README.md': 'v2' })
    const result = await syncSkills(env.SPEC_BUCKET)

    expect(result).toMatchObject({ changed: false, filesWritten: 0, filesDeleted: 0 })
    expect((await env.SPEC_BUCKET.head(SKILLS_MANIFEST_KEY))?.etag).toBe(manifestEtag)
  })

  it('writes only the changed file and keeps the replaced one for one more sync', async () => {
    await mockSkillsArchive({
      'skills/wrangler/SKILL.md': WRANGLER,
      'skills/wrangler/references/deploy.md': '# Deploy v1\n',
      'skills/durable-objects/SKILL.md': DURABLE_OBJECTS
    })
    await syncSkills(env.SPEC_BUCKET)
    const first = await manifest()
    const oldDeployKey = fileKey(first, 'skill://wrangler/references/deploy.md')
    const before = await storedFiles()

    await mockSkillsArchive({
      'skills/wrangler/SKILL.md': WRANGLER,
      'skills/wrangler/references/deploy.md': '# Deploy v2\n',
      'skills/durable-objects/SKILL.md': DURABLE_OBJECTS
    })
    const second = await syncSkills(env.SPEC_BUCKET)

    expect(second).toMatchObject({
      changed: true,
      changedSkills: ['wrangler'],
      filesWritten: 1,
      filesDeleted: 0
    })
    const after = await storedFiles()
    // Unchanged files were not rewritten.
    for (const [key, etag] of before) expect(after.get(key)).toBe(etag)
    // The replaced file stays while an isolate may still hold the previous manifest.
    expect(after.has(oldDeployKey)).toBe(true)

    // The next change drops files that neither the new nor the previous manifest names.
    await mockSkillsArchive({
      'skills/wrangler/SKILL.md': WRANGLER,
      'skills/durable-objects/SKILL.md': DURABLE_OBJECTS
    })
    const third = await syncSkills(env.SPEC_BUCKET)

    expect(third).toMatchObject({ changedSkills: ['wrangler'], filesWritten: 0, filesDeleted: 1 })
    expect((await storedFiles()).has(oldDeployKey)).toBe(false)
  })

  it('keeps the previous skills when the archive has no valid skills', async () => {
    await mockSkillsArchive({ 'skills/wrangler/SKILL.md': WRANGLER })
    await syncSkills(env.SPEC_BUCKET)
    const before = await storedFiles()
    const manifestEtag = (await env.SPEC_BUCKET.head(SKILLS_MANIFEST_KEY))?.etag

    await mockSkillsArchive({ 'README.md': 'no skills here' })
    await expect(syncSkills(env.SPEC_BUCKET)).rejects.toThrow('contained no valid skills')

    expect(await storedFiles()).toEqual(before)
    expect((await env.SPEC_BUCKET.head(SKILLS_MANIFEST_KEY))?.etag).toBe(manifestEtag)
  })

  it('records which skills were removed', async () => {
    await mockSkillsArchive({
      'skills/wrangler/SKILL.md': WRANGLER,
      'skills/durable-objects/SKILL.md': DURABLE_OBJECTS
    })
    await syncSkills(env.SPEC_BUCKET)

    await mockSkillsArchive({ 'skills/wrangler/SKILL.md': WRANGLER })
    const result = await syncSkills(env.SPEC_BUCKET)

    expect(result.changedSkills).toEqual(['durable-objects'])
    expect((await manifest()).skills.map(({ skill }) => skill.uri)).toEqual([
      'skill://wrangler/SKILL.md'
    ])
  })
})

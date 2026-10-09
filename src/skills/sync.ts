import { USER_AGENT } from '../constants'
import { buildSkillsManifest } from './bundle'
import { readTar } from './tar'
import {
  SKILL_FILES_PREFIX,
  SKILLS_MANIFEST_KEY,
  SkillsManifest,
  skillFileKey,
  type Skill
} from './types'

export const SKILLS_REPOSITORY = 'cloudflare/skills'

/**
 * The repository's default-branch tarball. codeload is not subject to the
 * GitHub REST API's unauthenticated rate limit, and one archive replaces a
 * request per file.
 */
export const SKILLS_ARCHIVE_URL = `https://codeload.github.com/${SKILLS_REPOSITORY}/tar.gz/refs/heads/main`

/** How many R2 writes the sync keeps in flight. */
const PUT_CONCURRENCY = 16

/** What one sync changed. */
export interface SkillsSyncResult {
  readonly changed: boolean
  readonly commit: string | null
  /** Skills that were added, removed, or had any file change. */
  readonly changedSkills: string[]
  /** File objects written: bytes no stored file already had. */
  readonly filesWritten: number
  /** File objects deleted: bytes neither the new nor the previous manifest names. */
  readonly filesDeleted: number
}

/**
 * Download `cloudflare/skills` and build the manifest and file bytes.
 *
 * @throws If the download fails, the archive cannot be read, or it holds no
 *   valid skills.
 */
export async function fetchSkills(
  now = new Date()
): Promise<{ manifest: SkillsManifest; blobs: Map<string, Uint8Array> }> {
  console.log('Fetching skills from:', SKILLS_ARCHIVE_URL)
  const response = await fetch(SKILLS_ARCHIVE_URL, { headers: { 'User-Agent': USER_AGENT } })
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch skills archive: ${response.status}`)
  }

  const archive = new Uint8Array(
    await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
  )
  const { files, comment } = readTar(archive)

  // git archive puts every path under one `<repo>-<ref>/` directory.
  const repositoryFiles = files.map((file) => ({
    path: file.path.slice(file.path.indexOf('/') + 1),
    bytes: file.bytes
  }))
  const commit = comment && /^[0-9a-f]{40}$/.test(comment) ? comment : null
  const { manifest, blobs, skipped } = await buildSkillsManifest(
    repositoryFiles,
    { repository: SKILLS_REPOSITORY, commit },
    now
  )

  for (const { name, reason } of skipped) console.warn(`Skipping skill ${name}: ${reason}`)
  if (manifest.skills.length === 0) {
    throw new Error('The skills archive contained no valid skills; keeping the previous skills')
  }
  return { manifest, blobs }
}

/**
 * Bring R2 up to date with `cloudflare/skills`, writing only what changed.
 * Runs from the six-hourly cron, next to the spec sync.
 *
 * 1. Files are stored by digest, so only bytes R2 doesn't already hold are written.
 * 2. The manifest is written after its files, and only when a skill changed.
 * 3. Files that neither the new nor the previous manifest names are deleted.
 *    Isolates cache the manifest for an hour, well under the sync interval,
 *    so no isolate still serves a manifest older than the previous one.
 *
 * On failure nothing is deleted and the previous manifest stays in place.
 *
 * @param bucket - The bucket that holds the server's other artifacts.
 */
export async function syncSkills(bucket: R2Bucket, now = new Date()): Promise<SkillsSyncResult> {
  const { manifest, blobs } = await fetchSkills(now)
  const previous = await readManifest(bucket)
  const commit = manifest.source.commit

  const changedSkills = diffSkills(previous?.skills ?? [], manifest.skills)
  if (previous && changedSkills.length === 0) {
    console.log(`Skills unchanged (commit ${commit ?? 'unknown'})`)
    return { changed: false, commit, changedSkills, filesWritten: 0, filesDeleted: 0 }
  }

  const stored = await listStoredFiles(bucket)
  const missing = [...blobs].filter(([digest]) => !stored.has(skillFileKey(digest)))
  for (let index = 0; index < missing.length; index += PUT_CONCURRENCY) {
    await Promise.all(
      missing
        .slice(index, index + PUT_CONCURRENCY)
        .map(([digest, bytes]) => bucket.put(skillFileKey(digest), bytes))
    )
  }

  await bucket.put(SKILLS_MANIFEST_KEY, JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' }
  })

  const referenced = new Set(
    [manifest, previous].flatMap((m) =>
      (m?.skills ?? []).flatMap((entry) => entry.files.map((file) => skillFileKey(file.digest)))
    )
  )
  const unreferenced = [...stored].filter((key) => !referenced.has(key))
  for (let index = 0; index < unreferenced.length; index += 1000) {
    await bucket.delete(unreferenced.slice(index, index + 1000))
  }

  console.log(
    `Skills updated (commit ${commit ?? 'unknown'}): ${changedSkills.join(', ')}; ` +
      `${missing.length} files written, ${unreferenced.length} deleted`
  )
  return {
    changed: true,
    commit,
    changedSkills,
    filesWritten: missing.length,
    filesDeleted: unreferenced.length
  }
}

async function readManifest(bucket: R2Bucket): Promise<SkillsManifest | undefined> {
  const object = await bucket.get(SKILLS_MANIFEST_KEY)
  if (!object) return undefined
  const parsed = SkillsManifest.safeParse(await object.json())
  if (!parsed.success) console.warn('Ignoring an unreadable skills manifest:', parsed.error.message)
  return parsed.success ? parsed.data : undefined
}

async function listStoredFiles(bucket: R2Bucket): Promise<Set<string>> {
  const keys = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix: SKILL_FILES_PREFIX, cursor })
    for (const object of page.objects) keys.add(object.key)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return keys
}

/** Names of skills whose entry differs between two manifests, including added and removed ones. */
function diffSkills(before: SkillsManifest['skills'], after: SkillsManifest['skills']): string[] {
  const serialize = (skill: Skill) => JSON.stringify(skill)
  const beforeByUri = new Map(before.map(({ skill }) => [skill.uri, serialize(skill)]))
  const afterByUri = new Map(after.map(({ skill }) => [skill.uri, serialize(skill)]))
  const names = new Set<string>()
  for (const { skill } of [...before, ...after]) {
    if (beforeByUri.get(skill.uri) !== afterByUri.get(skill.uri)) names.add(skill.frontmatter.name)
  }
  return [...names].sort()
}

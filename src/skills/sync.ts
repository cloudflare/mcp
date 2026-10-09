import { USER_AGENT } from '../constants'
import { buildSkillsBundle } from './bundle'
import { readTar } from './tar'
import { SKILLS_BUNDLE_KEY, type SkillsBundle } from './types'

export const SKILLS_REPOSITORY = 'cloudflare/skills'

/**
 * The repository's default-branch tarball. codeload is not subject to the
 * GitHub REST API's unauthenticated rate limit, and one archive replaces a
 * request per file.
 */
export const SKILLS_ARCHIVE_URL = `https://codeload.github.com/${SKILLS_REPOSITORY}/tar.gz/refs/heads/main`

/**
 * Download `cloudflare/skills` and build the skills bundle.
 *
 * @throws If the download fails, the archive cannot be read, or it holds no
 *   valid skills.
 */
export async function fetchSkillsBundle(now = new Date()): Promise<SkillsBundle> {
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
  const { bundle, skipped } = await buildSkillsBundle(
    repositoryFiles,
    { repository: SKILLS_REPOSITORY, commit },
    now
  )

  for (const { name, reason } of skipped) console.warn(`Skipping skill ${name}: ${reason}`)
  if (bundle.skills.length === 0) {
    throw new Error('The skills archive contained no valid skills; keeping the previous bundle')
  }
  return bundle
}

/**
 * Write a fresh skills bundle to R2. Runs from the daily cron next to the
 * OpenAPI spec sync. On failure the previous bundle stays in place.
 *
 * @param bucket - The bucket that holds the server's other artifacts.
 */
export async function syncSkills(bucket: R2Bucket, now = new Date()): Promise<void> {
  const bundle = await fetchSkillsBundle(now)
  await bucket.put(SKILLS_BUNDLE_KEY, JSON.stringify(bundle), {
    httpMetadata: { contentType: 'application/json' }
  })
  console.log(
    `Skills updated (${bundle.skills.length} skills, commit ${bundle.source.commit ?? 'unknown'})`
  )
}

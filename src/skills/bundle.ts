import { parse as parseYaml } from 'yaml'
import {
  MAX_BYTES_PER_SKILL,
  MAX_RESOURCES_PER_SKILL,
  type Skill,
  type SkillFile,
  type SkillsManifest
} from './types'

/** A file inside one skill directory, with its path relative to the skill root. */
export interface SkillSourceFile {
  readonly path: string
  readonly bytes: Uint8Array
}

/** A built skill: its entry, how to serve each file, and each file's bytes by digest. */
export interface BuiltSkill {
  readonly skill: Skill
  readonly files: SkillFile[]
  readonly blobs: Map<string, Uint8Array>
}

export type SkillBuildResult =
  | ({ readonly ok: true } & BuiltSkill)
  | { readonly ok: false; readonly name: string; readonly reason: string }

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/
const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024

const MIME_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  sh: 'text/x-shellscript',
  py: 'text/x-python',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/typescript',
  html: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf'
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

/** `skill://<name>/<file-path>`, with each path segment percent-encoded. */
export function skillFileUri(name: string, path: string): string {
  return `skill://${name}/${path.split('/').map(encodeURIComponent).join('/')}`
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return strictUtf8.decode(bytes)
  } catch {
    return undefined
  }
}

function mimeTypeFor(path: string, isText: boolean): string {
  const extension = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : ''
  return MIME_TYPES[extension] ?? (isText ? 'text/plain' : 'application/octet-stream')
}

/**
 * Parse the YAML frontmatter at the top of a `SKILL.md` into a JSON object.
 *
 * @returns The frontmatter, or the reason it is unusable.
 */
export function parseFrontmatter(
  markdown: string
): { ok: true; frontmatter: Skill['frontmatter'] } | { ok: false; reason: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
  if (!match) return { ok: false, reason: 'SKILL.md has no YAML frontmatter' }

  let parsed: unknown
  try {
    // The core schema maps YAML onto JSON types only (no dates or binary).
    parsed = parseYaml(match[1] ?? '', { schema: 'core' })
  } catch (error) {
    return { ok: false, reason: `Invalid frontmatter YAML: ${String(error)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'Frontmatter is not a mapping' }
  }

  // Round-trip through JSON so the entry carries exactly what a host's parser sees.
  const frontmatter = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>
  const { name, description } = frontmatter
  if (typeof name !== 'string' || typeof description !== 'string') {
    return { ok: false, reason: 'Frontmatter needs string name and description fields' }
  }
  return { ok: true, frontmatter: { ...frontmatter, name, description } }
}

/**
 * Build the entry and served files for one skill directory.
 *
 * @param name - The skill directory name. It must equal the frontmatter `name`.
 * @param sourceFiles - Every regular file in the directory, paths relative to it.
 */
export async function buildSkill(
  name: string,
  sourceFiles: readonly SkillSourceFile[]
): Promise<SkillBuildResult> {
  const fail = (reason: string): SkillBuildResult => ({ ok: false, name, reason })

  if (name.length > MAX_NAME_LENGTH || !SKILL_NAME.test(name)) {
    return fail('Directory name is not a valid skill name')
  }
  if (sourceFiles.length > MAX_RESOURCES_PER_SKILL) {
    return fail(`More than ${MAX_RESOURCES_PER_SKILL} files`)
  }
  const totalBytes = sourceFiles.reduce((sum, file) => sum + file.bytes.byteLength, 0)
  if (totalBytes > MAX_BYTES_PER_SKILL) return fail(`More than ${MAX_BYTES_PER_SKILL} bytes`)

  const skillMd = sourceFiles.find((file) => file.path === 'SKILL.md')
  if (!skillMd) return fail('No SKILL.md at the skill root')
  const skillMdText = decodeUtf8(skillMd.bytes)
  if (skillMdText === undefined) return fail('SKILL.md is not UTF-8')

  const parsed = parseFrontmatter(skillMdText)
  if (!parsed.ok) return fail(parsed.reason)
  const { frontmatter } = parsed
  if (frontmatter.name !== name) {
    return fail(`Frontmatter name "${frontmatter.name}" does not match the directory`)
  }
  if (frontmatter.description.length === 0) return fail('Empty description')
  if (frontmatter.description.length > MAX_DESCRIPTION_LENGTH) {
    return fail(`Description longer than ${MAX_DESCRIPTION_LENGTH} characters`)
  }

  const ordered = [...sourceFiles].sort((a, b) =>
    a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)
  )
  const resources: Skill['resources'] = []
  const files: SkillFile[] = []
  const blobs = new Map<string, Uint8Array>()
  for (const file of ordered) {
    const uri = skillFileUri(name, file.path)
    const isText = decodeUtf8(file.bytes) !== undefined
    const digest = await sha256(file.bytes)
    resources.push({ uri, digest, size: file.bytes.byteLength })
    files.push({
      uri,
      mimeType: mimeTypeFor(file.path, isText),
      digest,
      encoding: isText ? 'text' : 'base64'
    })
    blobs.set(digest, file.bytes)
  }

  return {
    ok: true,
    skill: { uri: skillFileUri(name, 'SKILL.md'), frontmatter, resources },
    files,
    blobs
  }
}

function isSafeRelativePath(path: string): boolean {
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * Turn the files of a skills repository archive into a manifest and the bytes
 * of every file it names, keyed by digest.
 *
 * Each `skills/<name>/` directory becomes one skill. Directories that break a
 * rule are left out and reported in `skipped`.
 *
 * @param archiveFiles - Archive files, paths relative to the repository root.
 */
export async function buildSkillsManifest(
  archiveFiles: readonly SkillSourceFile[],
  source: SkillsManifest['source'],
  syncedAt: Date
): Promise<{
  manifest: SkillsManifest
  blobs: Map<string, Uint8Array>
  skipped: { name: string; reason: string }[]
}> {
  const byName = new Map<string, SkillSourceFile[]>()
  for (const file of archiveFiles) {
    const match = /^skills\/([^/]+)\/(.+)$/.exec(file.path)
    if (!match || !isSafeRelativePath(file.path)) continue
    const [, name = '', path = ''] = match
    const files = byName.get(name) ?? []
    files.push({ path, bytes: file.bytes })
    byName.set(name, files)
  }

  const skills: SkillsManifest['skills'] = []
  const blobs = new Map<string, Uint8Array>()
  const skipped: { name: string; reason: string }[] = []
  for (const name of [...byName.keys()].sort()) {
    const result = await buildSkill(name, byName.get(name) ?? [])
    if (!result.ok) {
      skipped.push({ name: result.name, reason: result.reason })
      continue
    }
    skills.push({ skill: result.skill, files: result.files })
    for (const [digest, bytes] of result.blobs) blobs.set(digest, bytes)
  }

  return {
    manifest: { version: 2, source, syncedAt: syncedAt.toISOString(), skills },
    blobs,
    skipped
  }
}

import { z } from 'zod'

/**
 * Wire and storage shapes for the MCP Skills extension (SEP-2640,
 * `io.modelcontextprotocol/skills`), written against protocol `2026-07-28`.
 *
 * https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx
 */

export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills'

/**
 * R2 layout of the synced skills, next to the OpenAPI artifacts:
 *
 * - `skills/manifest.json`: every skill entry plus how to serve each file
 * - `skills/files/<sha256 hex>`: each file's raw bytes, keyed by its digest
 *
 * Files are content-addressed, so a sync only writes files whose bytes are
 * new, and the bytes served for a manifest digest always match it.
 */
export const SKILLS_MANIFEST_KEY = 'skills/manifest.json'
export const SKILL_FILES_PREFIX = 'skills/files/'

/** The R2 key holding the bytes with this digest. */
export function skillFileKey(digest: string): string {
  return SKILL_FILES_PREFIX + digest.slice('sha256:'.length)
}

/** Per-skill limits every conforming host must accept. Servers should not exceed them. */
export const MAX_RESOURCES_PER_SKILL = 512
export const MAX_BYTES_PER_SKILL = 16 * 1024 * 1024

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)

/** One file of a skill, with the digest and size of its raw bytes. */
export const SkillResource = z.object({
  uri: z.string(),
  digest: Digest,
  size: z.number().int().nonnegative()
})
export type SkillResource = z.infer<typeof SkillResource>

/** The `skills/list` and `skills/get` entry for one skill. */
export const Skill = z.object({
  uri: z.string(),
  frontmatter: z.looseObject({ name: z.string(), description: z.string() }),
  resources: z.array(SkillResource).max(MAX_RESOURCES_PER_SKILL)
})
export type Skill = z.infer<typeof Skill>

/** How to serve one skill file. Its bytes live at `skillFileKey(digest)`. */
export const SkillFile = z.object({
  uri: z.string(),
  mimeType: z.string(),
  digest: Digest,
  /** `text` files are served as UTF-8 `text`, everything else as base64 `blob`. */
  encoding: z.enum(['text', 'base64'])
})
export type SkillFile = z.infer<typeof SkillFile>

/**
 * The manifest the sync writes. It changes only when a skill does, and it is
 * written after every file it names, so a reader never sees a digest whose
 * bytes are missing.
 */
export const SkillsManifest = z.object({
  version: z.literal(2),
  source: z.object({ repository: z.string(), commit: z.string().nullable() }),
  syncedAt: z.string(),
  skills: z.array(z.object({ skill: Skill, files: z.array(SkillFile) }))
})
export type SkillsManifest = z.infer<typeof SkillsManifest>

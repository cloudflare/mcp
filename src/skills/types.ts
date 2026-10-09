import { z } from 'zod'

/**
 * Wire and storage shapes for the MCP Skills extension (SEP-2640,
 * `io.modelcontextprotocol/skills`), written against protocol `2026-07-28`.
 *
 * https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx
 */

export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills'

/** R2 key of the synced skills bundle, next to the OpenAPI artifacts. */
export const SKILLS_BUNDLE_KEY = 'skills.json'

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

/** A file's content as `resources/read` returns it: UTF-8 text, or base64 for anything else. */
export const SkillFile = z.union([
  z.object({ uri: z.string(), mimeType: z.string(), text: z.string() }),
  z.object({ uri: z.string(), mimeType: z.string(), blob: z.string() })
])
export type SkillFile = z.infer<typeof SkillFile>

/**
 * The R2 artifact the daily sync writes. Entries and file contents live in one
 * object so an update replaces both at once: a published digest never points
 * at bytes from a different sync.
 */
export const SkillsBundle = z.object({
  version: z.literal(1),
  source: z.object({ repository: z.string(), commit: z.string().nullable() }),
  syncedAt: z.string(),
  skills: z.array(z.object({ skill: Skill, files: z.array(SkillFile) }))
})
export type SkillsBundle = z.infer<typeof SkillsBundle>

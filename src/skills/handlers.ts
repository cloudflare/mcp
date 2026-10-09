import { z } from 'zod'
import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  type McpServer
} from '@modelcontextprotocol/server'
import { getSkills } from '../isolate-cache'
import { SKILLS_EXTENSION_ID } from './types'

/**
 * Skills change at most once a day (the sync cron) and are the same for every
 * user, so clients may cache listings and reads for an hour and share them.
 */
const SKILLS_CACHE = { ttlMs: 60 * 60 * 1000, cacheScope: 'public' } as const

const ListSkillsParams = z.looseObject({ cursor: z.string().optional() }).optional()
const GetSkillParams = z.looseObject({ uri: z.string() })

/**
 * Serve the synced `cloudflare/skills` catalog through the MCP Skills
 * extension (`io.modelcontextprotocol/skills`).
 *
 * - `skills/list` and `skills/get` return entries with a digest and size for
 *   every file, so hosts can verify what they read.
 * - `resources/read` serves each file at `skill://<name>/<path>`.
 * - `resources/list` lists each skill's `SKILL.md` only. The full file list is
 *   in the skill entry.
 *
 * The capability is declared without `directoryRead`: every entry carries a
 * complete manifest, which the spec lets hosts answer directory questions from.
 */
export function registerSkills(server: McpServer): void {
  server.server.registerCapabilities({
    resources: {},
    extensions: { [SKILLS_EXTENSION_ID]: {} }
  })

  server.server.setRequestHandler('skills/list', { params: ListSkillsParams }, async (params) => {
    // The whole catalog fits on one page, so this server never issues a cursor.
    if (params?.cursor !== undefined) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown cursor')
    }
    const { skills } = await getSkills()
    return { skills: [...skills], ...SKILLS_CACHE }
  })

  server.server.setRequestHandler('skills/get', { params: GetSkillParams }, async ({ uri }) => {
    const skill = (await getSkills()).skillsByUri.get(uri)
    if (!skill) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No skill is served at ${uri}`)
    }
    return { skill, ...SKILLS_CACHE }
  })

  server.server.setRequestHandler('resources/list', async () => {
    const { skills } = await getSkills()
    return {
      resources: skills.map((skill) => ({
        uri: skill.uri,
        name: skill.frontmatter.name,
        description: skill.frontmatter.description,
        mimeType: 'text/markdown'
      })),
      ...SKILLS_CACHE
    }
  })

  server.server.setRequestHandler('resources/templates/list', () => ({
    resourceTemplates: [],
    ...SKILLS_CACHE
  }))

  server.server.setRequestHandler('resources/read', async (request) => {
    const { uri } = request.params
    const file = (await getSkills()).filesByUri.get(uri)
    if (!file) throw new ResourceNotFoundError(uri, `No resource is served at ${uri}`)
    return { contents: [file], ...SKILLS_CACHE }
  })
}

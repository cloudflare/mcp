import { z } from 'zod'
import type { CallToolResult, McpServer, Tool } from '@modelcontextprotocol/server'
import type { AuthProps } from '../auth/types'
import { OAUTH_TOOL_META } from './security-schemes'

const TITLE = 'Current Cloudflare Identity'

const DESCRIPTION =
  'Return the Cloudflare user or account that this connection is authenticated as. ' +
  'Takes no arguments. The id is stable across token refresh, reconnection and permission changes.'

/** A Cloudflare user or account ID that can anchor a profile. */
const SubjectIdSchema = z.string().regex(/\S/)

const ID_DESCRIPTION =
  'Opaque profile identifier. Unique within this server, unchanged across token refresh, reconnection, and display-metadata changes. Never reassigned to another profile.'
const NAME_DESCRIPTION = 'Display name for the authenticated profile.'
const EMAIL_DESCRIPTION = 'Email address for display; not used as the profile identity.'

/** The OpenAI profile response. `id` is the only field clients may use as identity. */
const WhoamiOutputSchema = z.strictObject({
  id: z.string().min(1).regex(/\S/).describe(ID_DESCRIPTION),
  name: z.string().optional().describe(NAME_DESCRIPTION),
  email: z.string().optional().describe(EMAIL_DESCRIPTION)
})

/** The profile `whoami` returns. */
type Whoami = z.infer<typeof WhoamiOutputSchema>

/** `whoami` accepts only an empty argument object. */
export const WhoamiInputSchema = z.strictObject({})

const ANNOTATIONS = {
  title: TITLE,
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false
}

/**
 * Tool `_meta`. `openai/profile` marks this as the tool ChatGPT calls to tell
 * connected accounts apart. SDK v2 has no top-level `securitySchemes`, so it
 * goes in OpenAI's `_meta` mirror. The scopes are the identity scopes every
 * grant already holds.
 */
const META = {
  'openai/profile': true,
  ...OAUTH_TOOL_META
}

/**
 * Wire definition served by the non-Code-Mode `tools/list`. It is the same for
 * every session; only `tools/call` reads the credential. Tests keep it identical
 * to what the SDK emits for {@link registerWhoamiTool}.
 */
export const WHOAMI_TOOL: Tool = {
  name: 'whoami',
  title: TITLE,
  description: DESCRIPTION,
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  outputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, pattern: '\\S', description: ID_DESCRIPTION },
      name: { type: 'string', description: NAME_DESCRIPTION },
      email: { type: 'string', description: EMAIL_DESCRIPTION }
    },
    required: ['id'],
    additionalProperties: false
  },
  annotations: ANNOTATIONS,
  _meta: META
}

/**
 * The profile this credential represents. User credentials (OAuth, `cfut_`,
 * `cfoat_`, legacy user tokens) resolve to the Cloudflare user, so every
 * connection of that user is one profile. Account tokens resolve to their
 * account. The prefix keeps the two ID spaces apart.
 *
 * This format is a permanent contract: clients store these IDs to recognise
 * a profile across reconnects. Never change it.
 */
function whoamiFor(props: AuthProps): Whoami | undefined {
  const subject = SubjectIdSchema.safeParse(
    props.type === 'user_token' ? props.user.id : props.account.id
  )
  if (!subject.success) return undefined
  return props.type === 'user_token'
    ? { id: `user:${subject.data}`, ...(props.user.email && { email: props.user.email }) }
    : { id: `account:${subject.data}`, ...(props.account.name && { name: props.account.name }) }
}

/**
 * Run `whoami` for a validated credential.
 *
 * @param props - The request's validated credential.
 * @returns The profile as `structuredContent` and as JSON text, or a tool error
 *   when the credential carries no usable ID.
 */
export function runWhoamiTool(props: AuthProps): CallToolResult {
  // Only possible with a grant whose identity probe returned an empty ID.
  // OpenAI requires an error here rather than a placeholder identity.
  const whoami = whoamiFor(props)
  if (!whoami) {
    return {
      content: [{ type: 'text', text: 'This credential has no Cloudflare user or account ID.' }],
      isError: true
    }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(whoami) }],
    structuredContent: whoami
  }
}

/**
 * Register `whoami` on a Code Mode server.
 *
 * @param server - The per-request MCP server.
 * @param props - The request's validated credential.
 */
export function registerWhoamiTool(server: McpServer, props: AuthProps): void {
  server.registerTool(
    WHOAMI_TOOL.name,
    {
      title: TITLE,
      description: DESCRIPTION,
      inputSchema: WhoamiInputSchema,
      outputSchema: WhoamiOutputSchema,
      annotations: { ...ANNOTATIONS },
      _meta: META
    },
    () => runWhoamiTool(props)
  )
}

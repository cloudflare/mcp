import { z } from 'zod'
import type { CallToolResult, McpServer, Tool } from '@modelcontextprotocol/server'
import type { AuthProps } from '../auth/types'

export const ProfileInputSchema = z.strictObject({})
const ProfileSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .regex(/\S/)
    .describe(
      'Opaque profile identifier, stable across refresh, reconnection, scope upgrades and display changes.'
    ),
  name: z.string().max(256).optional().describe('Display name for the authenticated profile.'),
  email: z.string().max(320).optional().describe('Email address for display, not profile identity.')
})

/** Public metadata is identical for all credentials and both tool modes. */
export const PROFILE_TOOL: Tool = {
  name: 'get_profile',
  title: 'Cloudflare Profile',
  description:
    "Return the profile represented by this request's authenticated credentials. Its opaque ID is stable across token refresh, reconnection, scope upgrades and display changes.",
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {},
    additionalProperties: false
  },
  outputSchema: z.toJSONSchema(ProfileSchema),
  annotations: {
    title: 'Cloudflare Profile',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  },
  _meta: { 'openai/profile': true }
}

/** Use validated identity, never a caller-supplied selector or a changing grant/token. */
export async function runProfileTool(
  props: AuthProps
): Promise<CallToolResult & { structuredContent?: z.infer<typeof ProfileSchema> }> {
  const subject = props.type === 'user_token' ? props.user.id : props.account.id
  if (!subject.trim()) {
    return { content: [{ type: 'text', text: 'Profile identity unavailable.' }], isError: true }
  }

  // User OAuth and direct user credentials represent one profile. Account-owned
  // credentials use a disjoint namespace, even if a provider ID happens to match.
  // Hashing the immutable namespace/ID keeps internal relationships out of the ID.
  const namespace = props.type === 'user_token' ? 'user' : 'account'
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(['cloudflare-profile-v1', namespace, subject]))
  )
  const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  )
  const profile = ProfileSchema.parse({
    id,
    ...(props.type === 'user_token'
      ? { email: props.user.email.slice(0, 320) }
      : { name: props.account.name.slice(0, 256) })
  })
  return {
    content: [{ type: 'text', text: JSON.stringify(profile) }],
    structuredContent: profile,
    isError: false
  }
}

export function registerProfileTool(server: McpServer, props: AuthProps): void {
  server.registerTool(
    PROFILE_TOOL.name,
    {
      title: PROFILE_TOOL.title,
      description: PROFILE_TOOL.description,
      inputSchema: ProfileInputSchema,
      outputSchema: ProfileSchema,
      annotations: PROFILE_TOOL.annotations,
      _meta: PROFILE_TOOL._meta
    },
    () => runProfileTool(props)
  )
}

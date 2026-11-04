import { z } from 'zod'
import { env } from 'cloudflare:workers'
import type { CallToolResult, McpServer, Tool } from '@modelcontextprotocol/server'
import {
  ACCOUNT_DISCOVERY_GUIDANCE,
  autoResolvedAccountId,
  missingAccountMessage,
  unknownAccountHint
} from '../../auth/account-access'
import type { AuthProps } from '../../auth/types'
import { AttentionReportSchema, reportText, sortItems, type AttentionReport } from './report'
import { SOURCES, loadFeed, type FeedRequest } from './sources'

const NAME = 'show_attention'
const TITLE = 'Cloudflare: needs attention'
const DESCRIPTION =
  'Show what in a Cloudflare account needs action now: notifications that fired in the last 7 days, open Security Center insights, and active Workers Observability issues. ' +
  'Each item says what to look into next. Read-only. ' +
  'Pass account_id when the connection can reach more than one account.'

const READ_SCOPES = [
  'notifications.read',
  'account-security-center-insights.read',
  'workers-observability.read'
]

export const AttentionInputSchema = z.strictObject({
  account_id: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional()
    .describe('Cloudflare account ID. Optional when the connection reaches exactly one account.')
})

const ANNOTATIONS = {
  title: TITLE,
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false
}

const META = {
  securitySchemes: [{ type: 'oauth2', scopes: READ_SCOPES }]
}

export const ATTENTION_TOOL: Tool = {
  name: NAME,
  title: TITLE,
  description: DESCRIPTION,
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      account_id: {
        type: 'string',
        pattern: '^[0-9a-f]{32}$',
        description:
          'Cloudflare account ID. Optional when the connection reaches exactly one account.'
      }
    },
    additionalProperties: false
  },
  annotations: ANNOTATIONS,
  _meta: META
}

export async function buildAttentionReport(request: FeedRequest): Promise<AttentionReport> {
  const results = await Promise.all(SOURCES.map((source) => loadFeed(source, request)))
  return {
    accountId: request.accountId,
    generatedAt: request.now.toISOString(),
    items: sortItems(results.flatMap((result) => (result.ok ? result.items : []))),
    unavailable: results.flatMap((result) => (result.ok ? [] : [result.unavailable]))
  }
}

function toolError(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

export async function runAttentionTool(
  props: AuthProps,
  input: z.infer<typeof AttentionInputSchema>,
  now = new Date()
): Promise<CallToolResult> {
  const accountId = input.account_id ?? autoResolvedAccountId(props)
  if (!accountId) return toolError(missingAccountMessage(props, ACCOUNT_DISCOVERY_GUIDANCE))
  const unknownAccount = unknownAccountHint(props, accountId)
  if (unknownAccount) return toolError(unknownAccount)
  const report = AttentionReportSchema.parse(
    await buildAttentionReport({
      apiBase: env.CLOUDFLARE_API_BASE,
      accessToken: props.accessToken,
      accountId,
      now
    })
  )
  return {
    content: [{ type: 'text', text: reportText(report) }],
    structuredContent: report,
    isError: report.items.length === 0 && report.unavailable.length === SOURCES.length
  }
}

export function registerAttentionTool(server: McpServer, props: AuthProps): void {
  server.registerTool(
    NAME,
    {
      title: TITLE,
      description: DESCRIPTION,
      inputSchema: AttentionInputSchema,
      annotations: { ...ANNOTATIONS },
      _meta: META
    },
    (input) => runAttentionTool(props, input)
  )
}

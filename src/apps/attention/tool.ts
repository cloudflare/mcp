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
import { ATTENTION_PANEL_HTML } from './panel-html'
import { AttentionReportSchema, reportText, sortItems, type AttentionReport } from './report'
import { SOURCES, loadFeed, type FeedRequest } from './sources'

export const ATTENTION_RESOURCE_URI = 'ui://cloudflare/attention-panel.html'
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'

const NAME = 'show_attention'
const TITLE = 'Cloudflare: needs attention'
const DESCRIPTION =
  'Show what in a Cloudflare account needs action now: notifications that fired in the last 7 days, open Security Center insights, and active Workers Observability issues. ' +
  'Renders an interactive panel where each item can start a follow-up. Read-only. ' +
  'Pass account_id when the connection can reach more than one account.'

const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5 17.5 16H2.5z"/><path d="M10 8v3.5"/><path d="M10 14h.01"/></svg>'

const ICON = {
  src: `data:image/svg+xml;base64,${btoa(ICON_SVG)}`,
  mimeType: 'image/svg+xml',
  sizes: ['any']
}

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
  ui: { resourceUri: ATTENTION_RESOURCE_URI, visibility: ['model', 'app'] },
  'openai/outputTemplate': ATTENTION_RESOURCE_URI,
  'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] },
  securitySchemes: [{ type: 'oauth2', scopes: READ_SCOPES }]
}

export const ATTENTION_TOOL: Tool = {
  name: NAME,
  title: TITLE,
  description: DESCRIPTION,
  icons: [ICON],
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

export const ATTENTION_RESOURCE = {
  uri: ATTENTION_RESOURCE_URI,
  name: 'attention-panel',
  title: TITLE,
  mimeType: MCP_APP_MIME_TYPE,
  _meta: {
    ui: {
      csp: { connectDomains: [], resourceDomains: [] },
      prefersBorder: true
    }
  }
}

export function readAttentionResource() {
  return {
    contents: [
      {
        uri: ATTENTION_RESOURCE_URI,
        mimeType: MCP_APP_MIME_TYPE,
        text: ATTENTION_PANEL_HTML,
        _meta: ATTENTION_RESOURCE._meta
      }
    ]
  }
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
      icons: [ICON],
      inputSchema: AttentionInputSchema,
      annotations: { ...ANNOTATIONS },
      _meta: META
    },
    (input) => runAttentionTool(props, input)
  )
}

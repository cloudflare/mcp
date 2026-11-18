import { z } from 'zod'
import { env } from 'cloudflare:workers'
import type { CallToolResult, McpServer, Tool } from '@modelcontextprotocol/server'
import { USER_AGENT } from '../constants'
import { withCachedJsonSchema } from '../lib/isolate-json-schema'

const NAME = 'submit_feedback'
const TITLE = 'Send Feedback to Cloudflare'

const DESCRIPTION =
  'Send a short report to Cloudflare about a problem with Cloudflare products, this MCP server or its tools. ' +
  'You SHOULD call this when the user asks to send feedback, experiences frustration with Cloudflare, or after a Cloudflare tool or API failed in a way that looks like a Cloudflare bug. In these cases show the user a summary of the feedback you are going to send and ask permission to send it. ' +
  "Never send feedback without the user's permission. " +
  'Describe what was attempted, what was expected and what happened. ' +
  'Leave out secrets, API tokens, personal data, account or zone IDs and full conversations. ' +
  'The result holds a submission ID; tell the user.'

const SEND_TIMEOUT_MS = 5000

const InputSchema = withCachedJsonSchema(
  z.strictObject({
    message: z.string().min(1).max(4000).describe('The feedback, in plain words.'),
    type: z
      .enum(['bug', 'friction', 'feature', 'docs', 'praise', 'other'])
      .optional()
      .describe('What kind of feedback this is.'),
    impact: z
      .enum(['blocked', 'worked_around', 'friction', 'none'])
      .optional()
      .describe('How much the problem got in the way.'),
    product: z
      .string()
      .max(64)
      .optional()
      .describe('The Cloudflare product it is about, e.g. "workers", "d1", "dns".'),
    tool: z
      .string()
      .max(128)
      .optional()
      .describe('The tool of this server the feedback is about, e.g. "execute".'),
    task: z.string().max(2000).optional().describe('What the user was trying to do.'),
    expected: z.string().max(2000).optional().describe('What should have happened.'),
    actual: z.string().max(2000).optional().describe('What happened instead.')
  })
)

type FeedbackInput = z.infer<typeof InputSchema>

export type ToolMode = 'codemode' | 'direct'

const ANNOTATIONS = {
  title: TITLE,
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true
}

const FeedbackEnvSchema = z.object({ FEEDBACK_URL: z.url({ protocol: /^https$/ }) })
const AcceptedSchema = z.object({ submission_id: z.string() })

export function feedbackUrl(): string | undefined {
  const parsed = FeedbackEnvSchema.safeParse(env)
  return parsed.success ? parsed.data.FEEDBACK_URL : undefined
}

export function feedbackSubmission(
  { tool, ...report }: FeedbackInput,
  mode: ToolMode,
  submissionId: string
): Record<string, unknown> {
  return {
    schema_version: 1,
    submission_id: submissionId,
    source: 'mcp',
    ...report,
    fields: { mcp_mode: mode, ...(tool && { mcp_tool: tool }) }
  }
}

function toolError(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function refusal(response: Response): CallToolResult {
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After')
    const wait = retryAfter ? ` Try again in ${retryAfter} seconds.` : ''
    return toolError(`Cloudflare is receiving too much feedback right now.${wait}`)
  }
  return toolError(`Cloudflare did not accept the feedback (HTTP ${response.status}).`)
}

async function send(input: FeedbackInput, mode: ToolMode, url: string): Promise<CallToolResult> {
  const submissionId = crypto.randomUUID()
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(feedbackSubmission(input, mode, submissionId)),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    })
  } catch {
    return toolError('Could not reach the Cloudflare feedback service.')
  }
  if (response.status !== 202) return refusal(response)
  const accepted = AcceptedSchema.safeParse(await response.json().catch(() => undefined))
  const id = accepted.success ? accepted.data.submission_id : submissionId
  return {
    content: [
      { type: 'text', text: `Feedback sent. Submission ID: ${id}. Give the user this ID.` }
    ],
    structuredContent: { submission_id: id }
  }
}

export async function runSubmitFeedbackTool(
  args: unknown,
  mode: ToolMode
): Promise<CallToolResult> {
  const url = feedbackUrl()
  if (!url) return toolError(`Unknown tool: ${NAME}`)
  const parsed = InputSchema.safeParse(args)
  if (!parsed.success) {
    return toolError(`Invalid arguments for tool ${NAME}: ${parsed.error.message}`)
  }
  return send(parsed.data, mode, url)
}

export const SUBMIT_FEEDBACK_TOOL: Tool = {
  name: NAME,
  title: TITLE,
  description: DESCRIPTION,
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      message: {
        type: 'string',
        minLength: 1,
        maxLength: 4000,
        description: 'The feedback, in plain words.'
      },
      type: {
        type: 'string',
        enum: ['bug', 'friction', 'feature', 'docs', 'praise', 'other'],
        description: 'What kind of feedback this is.'
      },
      impact: {
        type: 'string',
        enum: ['blocked', 'worked_around', 'friction', 'none'],
        description: 'How much the problem got in the way.'
      },
      product: {
        type: 'string',
        maxLength: 64,
        description: 'The Cloudflare product it is about, e.g. "workers", "d1", "dns".'
      },
      tool: {
        type: 'string',
        maxLength: 128,
        description: 'The tool of this server the feedback is about, e.g. "execute".'
      },
      task: { type: 'string', maxLength: 2000, description: 'What the user was trying to do.' },
      expected: { type: 'string', maxLength: 2000, description: 'What should have happened.' },
      actual: { type: 'string', maxLength: 2000, description: 'What happened instead.' }
    },
    required: ['message'],
    additionalProperties: false
  },
  annotations: ANNOTATIONS
}

export function feedbackTools(): Tool[] {
  return feedbackUrl() ? [SUBMIT_FEEDBACK_TOOL] : []
}

export function registerSubmitFeedbackTool(server: McpServer): void {
  const url = feedbackUrl()
  if (!url) return
  server.registerTool(
    NAME,
    {
      title: TITLE,
      description: DESCRIPTION,
      inputSchema: InputSchema,
      annotations: { ...ANNOTATIONS }
    },
    (input) => send(input, 'codemode', url)
  )
}

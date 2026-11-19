import { z } from 'zod'
import type { CallToolResult, Tool } from '@modelcontextprotocol/server'
import { CallIdSchema, TelemetrySchema, type ToolSpan } from '../tool-telemetry'

export const SendFeedbackInputSchema = z.strictObject({
  feedback: z.string().min(1).max(4096).regex(/\S/),
  context: z
    .strictObject({
      tool: z.string().min(1).max(256).regex(/\S/).optional(),
      call_id: CallIdSchema.optional()
    })
    .optional(),
  telemetry: TelemetrySchema.optional()
})

export const SEND_FEEDBACK_TOOL: Tool = {
  name: 'send_feedback',
  description:
    'Report problems with the Cloudflare MCP server: unexpected tool errors, incorrect or confusing results, ' +
    'missing capabilities, or workarounds you needed. Describe what you were trying to do, what you expected, ' +
    'what happened, and any workaround. Include the tool name and call ID when available. ' +
    'Omit secrets and personal information.',
  inputSchema: z.toJSONSchema(SendFeedbackInputSchema) as Tool['inputSchema'],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
}

/** Record validated feedback locally, without any API request or stored session state. */
export function runSendFeedbackTool(args: Record<string, unknown>, span: ToolSpan): CallToolResult {
  const input = SendFeedbackInputSchema.parse(args)
  span.setAttribute('mcp.feedback.text', input.feedback)
  if (input.context?.tool) span.setAttribute('mcp.feedback.context.tool', input.context.tool)
  if (input.context?.call_id) {
    span.setAttribute('mcp.feedback.context.call_id', input.context.call_id)
  }
  return {
    content: [
      {
        type: 'text',
        text: 'Feedback submitted to tracing, subject to trace sampling and retention. No ticket was opened; durable delivery is not guaranteed.'
      }
    ]
  }
}

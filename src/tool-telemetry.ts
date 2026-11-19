import { tracing } from 'cloudflare:workers'
import { z } from 'zod'
import type { CallToolResult, JSONObject } from '@modelcontextprotocol/server'

/** Application limits, shared by validation and the advertised JSON Schema. */
export const TelemetrySchema = z.strictObject({
  intent: z
    .string()
    .min(1)
    .max(1024)
    .regex(/\S/)
    .describe(
      'Briefly describe the user goal this call supports. Omit secrets and personal information.'
    )
    .optional()
})

const TelemetryInputSchema = z.object({ telemetry: TelemetrySchema.optional() })
export const TELEMETRY_JSON_SCHEMA = z.toJSONSchema(TelemetrySchema) as JSONObject

/** A fresh UUID v4, never a JSON-RPC request ID or conversation identifier. */
export const CallIdSchema = z.uuidv4()
export const CALL_ID_META_KEY = 'cloudflare.com/mcp.call.id'

/** The small part of Workers tracing used here; injectable for boundary tests. */
export interface ToolSpan {
  setAttribute(key: string, value: string | boolean): unknown
  setStatus(status: { code: 'error' }): unknown
}

export interface ToolTracing {
  enterSpan<T>(name: string, callback: (span: ToolSpan) => T): T
}

/** Validate only telemetry, leaving business validation to Forge, and remove it. */
export function extractToolTelemetry(args: Record<string, unknown>) {
  const { telemetry } = TelemetryInputSchema.parse(args)
  const { telemetry: _telemetry, ...businessArgs } = args
  return { telemetry, businessArgs }
}

/** Tracing is best effort and must never affect execution or its result. */
function safely(record: () => unknown): void {
  try {
    record()
  } catch {
    // Do not log the error: it might contain attributes or other sensitive data.
  }
}

const NOOP_SPAN: ToolSpan = { setAttribute() {}, setStatus() {} }

/**
 * One direct invocation, including validation. Keep result fields and thrown
 * failures intact; only append correlation metadata and an error text block.
 * Never retry an operation when tracing fails after starting its callback.
 */
export async function traceToolCall(
  name: string,
  run: (span: ToolSpan) => Promise<CallToolResult>,
  tracer: ToolTracing = tracing
): Promise<CallToolResult> {
  const callId = crypto.randomUUID()
  let running: Promise<CallToolResult> | undefined
  const invoke = (span: ToolSpan): Promise<CallToolResult> => {
    const safeSpan: ToolSpan = {
      setAttribute: (key, value) => safely(() => span.setAttribute(key, value)),
      setStatus: (status) => safely(() => span.setStatus(status))
    }
    running = (async () => {
      safeSpan.setAttribute('mcp.tool.name', name)
      safeSpan.setAttribute('mcp.tool.mode', 'direct')
      safeSpan.setAttribute('mcp.call.id', callId)
      let isError = true
      try {
        const result = await run(safeSpan)
        isError = result.isError === true
        return {
          ...result,
          _meta: { ...result._meta, [CALL_ID_META_KEY]: callId },
          ...(isError && {
            content: [...result.content, { type: 'text' as const, text: `Call ID: ${callId}` }]
          })
        }
      } finally {
        safeSpan.setAttribute('mcp.tool.is_error', isError)
        if (isError) safeSpan.setStatus({ code: 'error' })
      }
    })()
    return running
  }
  try {
    return await tracer.enterSpan('mcp.tool_call', invoke)
  } catch {
    // A tracing failure before the callback must still execute the tool. If
    // it already ran, its original promise preserves its result or exception.
    if (running) return running
    return invoke(NOOP_SPAN)
  }
}

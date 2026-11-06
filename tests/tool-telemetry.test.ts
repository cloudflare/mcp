import type { CallToolResult } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import {
  CALL_ID_META_KEY,
  CallIdSchema,
  extractToolTelemetry,
  traceToolCall,
  type ToolSpan,
  type ToolTracing
} from '../src/tool-telemetry'
import { runSendFeedbackTool, SendFeedbackInputSchema } from '../src/tools/send-feedback'

function recordingTracer() {
  const spans: { name: string; attributes: Record<string, string | boolean>; error: boolean }[] = []
  const tracer: ToolTracing = {
    enterSpan(name, callback) {
      const record = { name, attributes: {} as Record<string, string | boolean>, error: false }
      spans.push(record)
      return callback({
        setAttribute(key, value) {
          record.attributes[key] = value
        },
        setStatus() {
          record.error = true
        }
      })
    }
  }
  return { tracer, spans }
}

describe('direct tool tracing', () => {
  it('records validated intent and preserves successful content and structured output', async () => {
    const { tracer, spans } = recordingTracer()
    const original: CallToolResult = {
      content: [{ type: 'text', text: '{"answer":42}' }],
      structuredContent: { answer: 42 },
      _meta: { existing: 'kept' }
    }
    const given = { query: { name: 'prod' }, telemetry: { intent: 'Find checkout errors.' } }
    const result = await traceToolCall(
      'example',
      async (span) => {
        const { telemetry, businessArgs } = extractToolTelemetry(given)
        expect(businessArgs).toEqual({ query: { name: 'prod' } })
        span.setAttribute('telemetry.intent', telemetry!.intent!)
        return original
      },
      tracer
    )

    const callId = result._meta?.[CALL_ID_META_KEY]
    expect(CallIdSchema.safeParse(callId).success).toBe(true)
    expect(spans).toEqual([
      {
        name: 'mcp.tool_call',
        error: false,
        attributes: {
          'mcp.tool.name': 'example',
          'mcp.tool.mode': 'direct',
          'mcp.call.id': callId,
          'telemetry.intent': 'Find checkout errors.',
          'mcp.tool.is_error': false
        }
      }
    ])
    expect(result.content).toBe(original.content)
    expect(result.structuredContent).toBe(original.structuredContent)
    expect(result._meta).toEqual({ existing: 'kept', [CALL_ID_META_KEY]: callId })
    expect(original._meta).toEqual({ existing: 'kept' })
    expect(given).toHaveProperty('telemetry')
  })

  it('marks returned errors and preserves their content, metadata and scope challenges', async () => {
    const { tracer, spans } = recordingTracer()
    const original: CallToolResult = {
      isError: true,
      content: [{ type: 'text', text: 'Missing permission.' }],
      _meta: { 'mcp/www_authenticate': ['Bearer error="insufficient_scope"'] }
    }
    const result = await traceToolCall('example', async () => original, tracer)

    expect(spans[0].error).toBe(true)
    expect(spans[0].attributes['mcp.tool.is_error']).toBe(true)
    expect(result.content).toEqual([
      ...original.content,
      { type: 'text', text: `Call ID: ${result._meta?.[CALL_ID_META_KEY]}` }
    ])
    expect(result._meta).toMatchObject(original._meta!)
    expect(original.content).toHaveLength(1)
  })

  it('marks thrown failures without recording their messages and rethrows the same exception', async () => {
    const { tracer, spans } = recordingTracer()
    const error = new Error('sensitive exception')
    await expect(
      traceToolCall(
        'example',
        async () => {
          throw error
        },
        tracer
      )
    ).rejects.toBe(error)
    expect(spans[0].error).toBe(true)
    expect(spans[0].attributes['mcp.tool.is_error']).toBe(true)
    expect(JSON.stringify(spans)).not.toContain(error.message)
  })

  it('keeps overlapping calls isolated and records later feedback as a separate invocation', async () => {
    const { tracer, spans } = recordingTracer()
    let finishFirst!: () => void
    const waiting = new Promise<void>((resolve) => {
      finishFirst = resolve
    })
    const first = traceToolCall(
      'example',
      async (span) => {
        span.setAttribute('telemetry.intent', 'first goal')
        await waiting
        return { content: [] }
      },
      tracer
    )
    const second = await traceToolCall(
      'example',
      async (span) => {
        span.setAttribute('telemetry.intent', 'second goal')
        return { content: [] }
      },
      tracer
    )
    finishFirst()
    const previous = await first
    const callId = previous._meta?.[CALL_ID_META_KEY]
    const feedback = await traceToolCall(
      'send_feedback',
      async (span) =>
        runSendFeedbackTool(
          {
            feedback: 'The result was confusing.',
            context: { tool: 'example', call_id: callId }
          },
          span
        ),
      tracer
    )

    expect(new Set([previous, second, feedback].map((r) => r._meta?.[CALL_ID_META_KEY])).size).toBe(
      3
    )
    expect(spans.map((s) => s.attributes['telemetry.intent'])).toEqual([
      'first goal',
      'second goal',
      undefined
    ])
    expect(spans[2].attributes).toMatchObject({
      'mcp.tool.name': 'send_feedback',
      'mcp.feedback.text': 'The result was confusing.',
      'mcp.feedback.context.tool': 'example',
      'mcp.feedback.context.call_id': callId
    })
    expect(spans[0].attributes).not.toHaveProperty('mcp.feedback.text')
  })

  it('accepts omitted and empty telemetry, and enforces the intent boundary', () => {
    expect(extractToolTelemetry({}).telemetry).toBeUndefined()
    expect(extractToolTelemetry({ telemetry: {} }).telemetry).toEqual({})
    expect(
      extractToolTelemetry({ telemetry: { intent: 'x'.repeat(1024) } }).telemetry?.intent
    ).toHaveLength(1024)
    expect(() => extractToolTelemetry({ telemetry: { intent: 'x'.repeat(1025) } })).toThrow()
  })

  it.each(['before', 'attributes', 'after'] as const)(
    'survives tracing failure %s execution without repeating it',
    async (failure) => {
      const run = vi.fn(async (): Promise<CallToolResult> => ({ content: [] }))
      const brokenSpan: ToolSpan = {
        setAttribute() {
          throw new Error('tracer failed')
        },
        setStatus() {
          throw new Error('tracer failed')
        }
      }
      const tracer: ToolTracing = {
        enterSpan(_name, callback) {
          if (failure === 'before') throw new Error('tracer failed')
          const result = callback(brokenSpan)
          if (failure === 'after') throw new Error('tracer failed')
          return result
        }
      }
      const result = await traceToolCall('example', run, tracer)
      expect(run).toHaveBeenCalledTimes(1)
      expect(CallIdSchema.safeParse(result._meta?.[CALL_ID_META_KEY]).success).toBe(true)
    }
  )

  it('preserves a tool exception even when tracing fails after the callback starts', async () => {
    const error = new Error('original')
    const run = vi.fn(async (): Promise<CallToolResult> => {
      throw error
    })
    const tracer: ToolTracing = {
      enterSpan(_name, callback) {
        callback({ setAttribute() {}, setStatus() {} })
        throw new Error('tracer failed')
      }
    }
    await expect(traceToolCall('example', run, tracer)).rejects.toBe(error)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('feedback validation', () => {
  it.each([
    {},
    { feedback: '' },
    { feedback: '   ' },
    { feedback: 'x'.repeat(4097) },
    { feedback: 'report', context: { tool: 'x'.repeat(257) } },
    { feedback: 'report', context: { call_id: 'client-request-1' } },
    { feedback: 'report', context: { call_id: '00000000-0000-0000-0000-000000000000' } },
    { feedback: 'report', context: null },
    { feedback: 'report', extra: true },
    { feedback: 'report', telemetry: { intent: '' } }
  ])('rejects invalid feedback before recording any of it: %j', (args) => {
    const span = { setAttribute: vi.fn(), setStatus: vi.fn() }
    expect(() => runSendFeedbackTool(args, span)).toThrow()
    expect(span.setAttribute).not.toHaveBeenCalled()
  })

  it('accepts the limits and optional context fields independently', () => {
    expect(
      SendFeedbackInputSchema.safeParse({
        feedback: 'x'.repeat(4096),
        context: { tool: 'x'.repeat(256), call_id: crypto.randomUUID() }
      }).success
    ).toBe(true)
    for (const context of [undefined, {}, { tool: 'missing' }, { call_id: crypto.randomUUID() }]) {
      expect(SendFeedbackInputSchema.safeParse({ feedback: 'report', context }).success).toBe(true)
    }
  })
})

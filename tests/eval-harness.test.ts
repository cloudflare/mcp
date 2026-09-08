import { env } from 'cloudflare:workers'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAgentTask } from '../evals/harness'
import { mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { clearSpec, seedSpec } from './helpers/spec'

/**
 * Regression test for the eval harness itself (`evals/harness.ts`), not for
 * any model's behaviour: a scripted `MockLanguageModelV4` stands in for the
 * LLM, so this runs in the regular suite with no API key and no network call,
 * yet still exercises the real worker (a real Worker Loader isolate runs the
 * scripted `search` call against a real seeded spec). It only proves the
 * plumbing — tools/list -> AI SDK tool defs -> tool execution against the real
 * worker -> results surfaced back — works; `npm run eval` is what checks
 * whether a real model uses that plumbing well.
 */

const ACCOUNT_ID = '00000000000000000000000000000001'
const API_TOKEN = 'cfat_eval-harness-token'

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined }
}

beforeEach(async () => {
  await seedSpec({
    '/accounts/{account_id}/workers/scripts': {
      get: {
        summary: 'List Workers scripts',
        tags: ['Workers'],
        parameters: [{ name: 'account_id', in: 'path', required: true }],
        responses: {}
      }
    }
  })
  mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Harness Test' }] })
})

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

describe('eval harness', () => {
  it('drives the real search tool from a scripted tool call and surfaces its result', async () => {
    const searchCode = `async () => {
      const results = [];
      for (const [path, methods] of Object.entries(spec.paths)) {
        for (const [method, op] of Object.entries(methods)) {
          results.push({ method: method.toUpperCase(), path, summary: op.summary });
        }
      }
      return results;
    }`

    let calls = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++
        if (calls === 1) {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'search',
                input: JSON.stringify({ code: searchCode })
              }
            ],
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage: USAGE,
            warnings: []
          }
        }
        return {
          content: [{ type: 'text', text: 'Found it.' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: USAGE,
          warnings: []
        }
      }
    })

    const result = await runAgentTask({
      model,
      token: API_TOKEN,
      prompt: 'Find the Workers scripts endpoint.',
      toolNames: ['search']
    })

    expect(calls).toBe(2)
    expect(result.text).toBe('Found it.')
    expect(result.toolCalls).toEqual([{ toolName: 'search', input: { code: searchCode } }])
    expect(result.toolResults).toHaveLength(1)
    expect(result.toolResults[0]?.toolName).toBe('search')
    expect(String(result.toolResults[0]?.output)).toContain(
      '/accounts/{account_id}/workers/scripts'
    )
  })

  it('relays an MCP-level tool error as text instead of failing the run', async () => {
    let calls = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++
        if (calls === 1) {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'search',
                input: JSON.stringify({ code: 'async () => { throw new Error("boom") }' })
              }
            ],
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage: USAGE,
            warnings: []
          }
        }
        return {
          content: [{ type: 'text', text: 'Search failed, so I stopped.' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: USAGE,
          warnings: []
        }
      }
    })

    const result = await runAgentTask({
      model,
      token: API_TOKEN,
      prompt: 'Find something.',
      toolNames: ['search']
    })

    expect(calls).toBe(2)
    expect(result.text).toBe('Search failed, so I stopped.')
    expect(result.toolResults[0]?.toolName).toBe('search')
    expect(String(result.toolResults[0]?.output)).toContain('boom')
  })
})

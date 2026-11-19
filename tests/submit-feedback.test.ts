import { env, exports } from 'cloudflare:workers'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { http, HttpResponse } from 'msw'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuthProps } from '../src/auth/types'
import {
  SUBMIT_FEEDBACK_TOOL,
  feedbackCallerKey,
  feedbackSubmission,
  feedbackUserHash,
  registerSubmitFeedbackTool,
  retryAfterSeconds,
  runSubmitFeedbackTool
} from '../src/tools/submit-feedback'
import { mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, mcpToolListRequest, modernMcpRequest, parseMcpResult } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server as msw } from './setup/msw'

const FEEDBACK_URL = 'https://feedback.example.com/v1/feedback'
const ACCOUNT_ID = '023e105f4ecef8ad9ca31a8372d0c353'
const TOKEN = 'cfat_feedback'
const REPORT = { type: 'bug', impact: 'friction' } as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function freshUser(): AuthProps {
  return {
    type: 'user_token',
    accessToken: TOKEN,
    user: { id: crypto.randomUUID(), email: 'feedback-test@example.com' },
    accounts: []
  }
}

interface Received {
  body: Record<string, unknown>
  headers: Record<string, string>
}

function acceptFeedback(): Received[] {
  const received: Received[] = []
  msw.use(
    http.post(FEEDBACK_URL, async ({ request }) => {
      const body = z.looseObject({ submission_id: z.string() }).parse(await request.json())
      received.push({ body, headers: Object.fromEntries(request.headers) })
      return HttpResponse.json(
        { status: 'accepted', submission_id: body.submission_id },
        { status: 202 }
      )
    })
  )
  return received
}

function respondWith(response: () => Response) {
  msw.use(http.post(FEEDBACK_URL, response))
}

async function sdkListing(): Promise<unknown> {
  const mcp = new McpServer({ name: 'feedback-schema-test', version: '1.0.0' })
  registerSubmitFeedbackTool(mcp, freshUser())
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)])
  try {
    return JSON.parse(JSON.stringify((await client.listTools()).tools))
  } finally {
    await client.close()
    await mcp.close()
  }
}

beforeEach(() => {
  Object.assign(env, { FEEDBACK_URL })
})

afterEach(() => {
  Object.assign(env, { FEEDBACK_URL: undefined, FEEDBACK_MCP_KEY: undefined })
})

describe('submit_feedback definition', () => {
  it('matches the definition the SDK generates for the Code Mode tool', async () => {
    expect(await sdkListing()).toEqual([SUBMIT_FEEDBACK_TOOL])
  })

  it('carries no output schema, so tools/list stays small', () => {
    expect(SUBMIT_FEEDBACK_TOOL).not.toHaveProperty('outputSchema')
  })

  it('tells agents when to offer feedback, to ask first, and not to include secrets', () => {
    expect(SUBMIT_FEEDBACK_TOOL.description).toContain('experiences frustration with Cloudflare')
    expect(SUBMIT_FEEDBACK_TOOL.description).toContain(
      'show the user a summary of the feedback you are going to send and ask permission'
    )
    expect(SUBMIT_FEEDBACK_TOOL.description).toContain(
      "Never send feedback without the user's permission"
    )
    expect(SUBMIT_FEEDBACK_TOOL.description).toContain('Leave out secrets')
    expect(SUBMIT_FEEDBACK_TOOL.description).toContain('at most once per task')
    expect(SUBMIT_FEEDBACK_TOOL.inputSchema.required).toEqual(['message', 'type', 'impact'])
  })
})

describe('submit_feedback report', () => {
  it('uses the shared feedback schema, with the MCP details in fields', () => {
    const body = feedbackSubmission(
      {
        message: 'execute failed',
        type: 'bug',
        impact: 'blocked',
        tool: 'execute'
      },
      'codemode',
      '7f0c2b8e-2f43-4c1a-9a51-0d3f6c1e8b2a'
    )

    expect(body).toEqual({
      schema_version: 1,
      submission_id: '7f0c2b8e-2f43-4c1a-9a51-0d3f6c1e8b2a',
      source: 'mcp',
      message: 'execute failed',
      type: 'bug',
      impact: 'blocked',
      fields: { mcp_mode: 'codemode', mcp_tool: 'execute' }
    })
  })

  it('sends no credential or account identity', async () => {
    const received = acceptFeedback()

    await runSubmitFeedbackTool({ ...REPORT, message: 'docs are wrong' }, 'direct', freshUser())

    expect(received).toHaveLength(1)
    expect(received[0].headers).not.toHaveProperty('authorization')
    expect(received[0].headers).not.toHaveProperty('cookie')
    expect(received[0].headers['user-agent']).toMatch(/^cloudflare-mcp/)
  })

  it('sends no server key headers when FEEDBACK_MCP_KEY is unset', async () => {
    const received = acceptFeedback()

    await runSubmitFeedbackTool({ ...REPORT, message: 'docs are wrong' }, 'direct', freshUser())

    expect(received[0].headers).not.toHaveProperty('x-feedback-mcp-key')
    expect(received[0].headers).not.toHaveProperty('x-feedback-mcp-user')
  })

  it('sends the server key and a keyed hash of the caller, never the caller ID', async () => {
    Object.assign(env, { FEEDBACK_MCP_KEY: 'feedback-key-for-tests' })
    const received = acceptFeedback()
    const user = freshUser()

    await runSubmitFeedbackTool({ ...REPORT, message: 'docs are wrong' }, 'direct', user)

    const headers = received[0].headers
    expect(headers['x-feedback-mcp-key']).toBe('feedback-key-for-tests')
    expect(headers['x-feedback-mcp-user']).toMatch(/^[0-9a-f]{64}$/)
    expect(headers['x-feedback-mcp-user']).toBe(
      await feedbackUserHash('feedback-key-for-tests', user)
    )
    expect(JSON.stringify(received[0])).not.toContain(feedbackCallerKey(user))
  })

  it('hashes each caller differently, and the same caller the same way', async () => {
    const a = freshUser()
    const b = freshUser()
    expect(await feedbackUserHash('k', a)).toBe(await feedbackUserHash('k', a))
    expect(await feedbackUserHash('k', a)).not.toBe(await feedbackUserHash('k', b))
    expect(await feedbackUserHash('k', a)).not.toBe(await feedbackUserHash('other', a))
  })

  it('returns the submission ID the endpoint accepted', async () => {
    acceptFeedback()

    const result = await runSubmitFeedbackTool(
      { ...REPORT, message: 'works great' },
      'codemode',
      freshUser()
    )

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({
      submission_id: expect.stringMatching(UUID)
    })
  })

  it('reports a rate limit with its retry time', async () => {
    respondWith(() =>
      HttpResponse.json(
        { error: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': '60' } }
      )
    )

    const result = await runSubmitFeedbackTool(
      { ...REPORT, message: 'the docs search returned nothing' },
      'codemode',
      freshUser()
    )

    expect(result).toMatchObject({ isError: true })
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('60 seconds') }])
  })

  it('reports a refused or unreachable endpoint as an error', async () => {
    respondWith(() => HttpResponse.json({ error: 'invalid' }, { status: 422 }))
    expect(
      await runSubmitFeedbackTool(
        { ...REPORT, message: 'the docs search returned nothing' },
        'codemode',
        freshUser()
      )
    ).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('HTTP 422') }]
    })

    respondWith(() => HttpResponse.error())
    expect(
      await runSubmitFeedbackTool(
        { ...REPORT, message: 'the docs search returned nothing' },
        'codemode',
        freshUser()
      )
    ).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('Could not reach') }]
    })
  })

  it('refuses arguments outside the schema without sending', async () => {
    const received = acceptFeedback()

    const result = await runSubmitFeedbackTool(
      { ...REPORT, message: 'the docs search returned nothing', account_id: ACCOUNT_ID },
      'direct',
      freshUser()
    )

    expect(result).toMatchObject({ isError: true })
    expect(received).toHaveLength(0)
  })

  it('sends an other_type label only with type other', () => {
    const id = '7f0c2b8e-2f43-4c1a-9a51-0d3f6c1e8b2a'
    expect(
      feedbackSubmission(
        { message: 'x', type: 'other', impact: 'none', other_type: 'billing' },
        'direct',
        id
      ).fields
    ).toEqual({ mcp_mode: 'direct', other_type: 'billing' })
    expect(
      feedbackSubmission(
        { message: 'x', type: 'bug', impact: 'none', other_type: 'billing' },
        'direct',
        id
      ).fields
    ).toEqual({ mcp_mode: 'direct' })
  })

  it('refuses an other_type label longer than three words', async () => {
    const received = acceptFeedback()

    const result = await runSubmitFeedbackTool(
      {
        message: 'billing page is unclear',
        type: 'other',
        impact: 'friction',
        other_type: 'one two three four'
      },
      'direct',
      freshUser()
    )

    expect(result).toMatchObject({ isError: true })
    expect(received).toHaveLength(0)
  })

  it.each(['test', 'TODO', 'n/a', 'None.', '  null  '])(
    'refuses the placeholder message %j without sending',
    async (message) => {
      const received = acceptFeedback()

      const result = await runSubmitFeedbackTool({ ...REPORT, message }, 'direct', freshUser())

      expect(result).toMatchObject({
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('placeholder') }]
      })
      expect(received).toHaveLength(0)
    }
  )

  it('refuses a report without type or impact', async () => {
    const received = acceptFeedback()

    for (const args of [
      { message: 'the docs search returned nothing', impact: 'friction' },
      { message: 'the docs search returned nothing', type: 'bug' }
    ]) {
      expect(await runSubmitFeedbackTool(args, 'direct', freshUser())).toMatchObject({
        isError: true
      })
    }
    expect(received).toHaveLength(0)
  })

  it('allows five reports a minute per user and refuses the sixth without sending', async () => {
    const received = acceptFeedback()
    const user = freshUser()

    for (let n = 0; n < 5; n++) {
      expect(
        (await runSubmitFeedbackTool({ ...REPORT, message: `r${n}` }, 'direct', user)).isError
      ).toBeUndefined()
    }
    const sixth = await runSubmitFeedbackTool({ ...REPORT, message: 'r5' }, 'direct', user)

    expect(sixth).toMatchObject({ isError: true })
    expect(received).toHaveLength(5)
    expect(
      (await runSubmitFeedbackTool({ ...REPORT, message: 'other user' }, 'direct', freshUser()))
        .isError
    ).toBeUndefined()
  })

  it('keys the limit on the user, or on the account for account tokens', () => {
    expect(
      feedbackCallerKey({
        type: 'user_token',
        accessToken: TOKEN,
        user: { id: 'u1', email: 'e' },
        accounts: []
      })
    ).toBe('user:u1')
    expect(
      feedbackCallerKey({
        type: 'account_token',
        accessToken: TOKEN,
        account: { id: ACCOUNT_ID, name: 'Acc' }
      })
    ).toBe(`account:${ACCOUNT_ID}`)
  })

  it('reads Retry-After as seconds or as an HTTP date', () => {
    const now = Date.parse('2026-11-18T12:00:00Z')
    expect(retryAfterSeconds('60', now)).toBe(60)
    expect(retryAfterSeconds('Wed, 18 Nov 2026 12:01:30 GMT', now)).toBe(90)
    expect(retryAfterSeconds('soon', now)).toBeUndefined()
    expect(retryAfterSeconds(null, now)).toBeUndefined()
  })

  it('refuses a plain-http endpoint', async () => {
    Object.assign(env, {
      FEEDBACK_URL: 'http://feedback.example.com/v1/feedback'
    })

    expect(
      await runSubmitFeedbackTool(
        { ...REPORT, message: 'the docs search returned nothing' },
        'codemode',
        freshUser()
      )
    ).toMatchObject({
      isError: true
    })
  })
})

describe('submit_feedback over MCP', () => {
  beforeEach(async () => {
    await seedSpec({})
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
  })

  afterEach(async () => {
    await clearKv(env.OAUTH_KV)
    await clearSpec()
  })

  async function toolNames(url: string): Promise<string[] | undefined> {
    const listed = await parseMcpResult(
      await exports.default.fetch(modernMcpRequest(TOKEN, 'tools/list', {}, { url }))
    )
    return listed.result?.tools?.map((tool) => tool.name)
  }

  it.each([
    ['Code Mode', MCP_URL],
    ['direct mode', `${MCP_URL}?codemode=false`]
  ])('is not offered in %s without a feedback endpoint', async (_mode, url) => {
    Object.assign(env, { FEEDBACK_URL: undefined })

    expect(await toolNames(url)).not.toContain('submit_feedback')
  })

  it.each([
    ['Code Mode', MCP_URL, 'codemode'],
    ['direct mode', `${MCP_URL}?codemode=false`, 'direct']
  ])('is listed and sends the report in %s', async (_mode, url, mode) => {
    const received = acceptFeedback()

    expect(await toolNames(url)).toContain('submit_feedback')

    const called = await parseMcpResult(
      await exports.default.fetch(
        modernMcpRequest(
          TOKEN,
          'tools/call',
          {
            name: 'submit_feedback',
            arguments: { ...REPORT, message: 'the D1 tool timed out' }
          },
          { url }
        )
      )
    )

    expect(called.result?.isError).toBeUndefined()
    expect(received).toHaveLength(1)
    expect(received[0].body.fields).toEqual({ mcp_mode: mode })
    expect(JSON.stringify(received[0].body)).not.toContain(ACCOUNT_ID)
  })

  it('is listed on the legacy tools/list path with feedback enabled', async () => {
    const listed = await parseMcpResult(await exports.default.fetch(mcpToolListRequest(TOKEN)))

    expect(listed.result?.tools?.map((tool) => tool.name)).toContain('submit_feedback')
  })
})

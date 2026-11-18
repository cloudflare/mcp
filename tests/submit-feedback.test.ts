import { env, exports } from 'cloudflare:workers'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server'
import { http, HttpResponse } from 'msw'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SUBMIT_FEEDBACK_TOOL,
  feedbackSubmission,
  registerSubmitFeedbackTool,
  runSubmitFeedbackTool
} from '../src/tools/submit-feedback'
import { mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, modernMcpRequest, parseMcpResult } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server as msw } from './setup/msw'

const FEEDBACK_URL = 'https://feedback.example.com/v1/feedback'
const ACCOUNT_ID = '023e105f4ecef8ad9ca31a8372d0c353'
const TOKEN = 'cfat_feedback'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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
  registerSubmitFeedbackTool(mcp)
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
  Object.assign(env, { FEEDBACK_URL: undefined })
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
  })
})

describe('submit_feedback report', () => {
  it('uses the shared feedback schema, with the MCP details in fields', () => {
    const body = feedbackSubmission(
      { message: 'execute failed', type: 'bug', impact: 'blocked', tool: 'execute' },
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

    await runSubmitFeedbackTool({ message: 'docs are wrong' }, 'direct')

    expect(received).toHaveLength(1)
    expect(received[0].headers).not.toHaveProperty('authorization')
    expect(received[0].headers).not.toHaveProperty('cookie')
    expect(received[0].headers['user-agent']).toMatch(/^cloudflare-mcp/)
  })

  it('returns the submission ID the endpoint accepted', async () => {
    acceptFeedback()

    const result = await runSubmitFeedbackTool({ message: 'works great' }, 'codemode')

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ submission_id: expect.stringMatching(UUID) })
  })

  it('reports a rate limit with its retry time', async () => {
    respondWith(() =>
      HttpResponse.json(
        { error: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': '60' } }
      )
    )

    const result = await runSubmitFeedbackTool({ message: 'x' }, 'codemode')

    expect(result).toMatchObject({ isError: true })
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('60 seconds') }])
  })

  it('reports a refused or unreachable endpoint as an error', async () => {
    respondWith(() => HttpResponse.json({ error: 'invalid' }, { status: 422 }))
    expect(await runSubmitFeedbackTool({ message: 'x' }, 'codemode')).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('HTTP 422') }]
    })

    respondWith(() => HttpResponse.error())
    expect(await runSubmitFeedbackTool({ message: 'x' }, 'codemode')).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining('Could not reach') }]
    })
  })

  it('refuses arguments outside the schema without sending', async () => {
    const received = acceptFeedback()

    const result = await runSubmitFeedbackTool({ message: 'x', account_id: ACCOUNT_ID }, 'direct')

    expect(result).toMatchObject({ isError: true })
    expect(received).toHaveLength(0)
  })

  it('refuses a plain-http endpoint', async () => {
    Object.assign(env, { FEEDBACK_URL: 'http://feedback.example.com/v1/feedback' })

    expect(await runSubmitFeedbackTool({ message: 'x' }, 'codemode')).toMatchObject({
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
          { name: 'submit_feedback', arguments: { message: 'the D1 tool timed out' } },
          { url }
        )
      )
    )

    expect(called.result?.isError).toBeUndefined()
    expect(received).toHaveLength(1)
    expect(received[0].body.fields).toEqual({ mcp_mode: mode })
    expect(JSON.stringify(received[0].body)).not.toContain(ACCOUNT_ID)
  })
})

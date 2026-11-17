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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

async function listTools(mcp: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)])
  try {
    return (await client.listTools()).tools
  } finally {
    await client.close()
    await mcp.close()
  }
}

function acceptFeedback(received: unknown[]) {
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
}

describe('submit_feedback definition', () => {
  it('matches the definition the SDK generates for the Code Mode tool', async () => {
    const mcp = new McpServer({ name: 'feedback-schema-test', version: '1.0.0' })
    registerSubmitFeedbackTool(mcp, FEEDBACK_URL)

    expect(JSON.parse(JSON.stringify(await listTools(mcp)))).toEqual([SUBMIT_FEEDBACK_TOOL])
  })

  it('tells agents not to send feedback unprompted or include secrets', () => {
    expect(SUBMIT_FEEDBACK_TOOL.description).toContain(
      'Do not send feedback on your own initiative'
    )
    expect(SUBMIT_FEEDBACK_TOOL.description).toContain('Leave out secrets')
    expect(SUBMIT_FEEDBACK_TOOL.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true
    })
  })
})

describe('submit_feedback submission', () => {
  it('builds a schema_version 1 body for the shared feedback endpoint', () => {
    const body = feedbackSubmission(
      { message: 'execute failed', type: 'bug', impact: 'blocked', tool: 'execute' },
      'codemode',
      '7f0c2b8e-2f43-4c1a-9a51-0d3f6c1e8b2a'
    )

    expect(body).toMatchObject({
      schema_version: 1,
      submission_id: '7f0c2b8e-2f43-4c1a-9a51-0d3f6c1e8b2a',
      source: 'mcp',
      message: 'execute failed',
      type: 'bug',
      impact: 'blocked',
      fields: { mcp_mode: 'codemode', mcp_tool: 'execute' }
    })
    expect(body).not.toHaveProperty('tool')
  })

  it('sends no credential or account identity with the report', async () => {
    const received: Array<{ body: unknown; headers: Record<string, string> }> = []
    acceptFeedback(received)

    await runSubmitFeedbackTool({ message: 'docs are wrong' }, 'direct', FEEDBACK_URL)

    expect(received).toHaveLength(1)
    expect(received[0].headers).not.toHaveProperty('authorization')
    expect(received[0].headers['user-agent']).toMatch(/^cloudflare-mcp/)
    expect(JSON.stringify(received[0].body)).not.toContain(ACCOUNT_ID)
  })

  it('returns the submission ID the endpoint accepted', async () => {
    acceptFeedback([])

    const result = await runSubmitFeedbackTool({ message: 'works great' }, 'codemode', FEEDBACK_URL)

    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ submission_id: expect.stringMatching(UUID) })
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining('Give the user this ID') }
    ])
  })

  it('reports a rate limit with its retry time', async () => {
    msw.use(
      http.post(FEEDBACK_URL, () =>
        HttpResponse.json(
          { error: 'rate_limited' },
          { status: 429, headers: { 'Retry-After': '60' } }
        )
      )
    )

    const result = await runSubmitFeedbackTool({ message: 'x' }, 'codemode', FEEDBACK_URL)

    expect(result).toMatchObject({ isError: true })
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('60 seconds') }])
  })

  it('reports a refused or unreachable endpoint without claiming it was stored', async () => {
    msw.use(http.post(FEEDBACK_URL, () => HttpResponse.json({ error: 'invalid' }, { status: 422 })))
    const refused = await runSubmitFeedbackTool({ message: 'x' }, 'codemode', FEEDBACK_URL)
    expect(refused).toMatchObject({ isError: true })
    expect(refused.content).toEqual([{ type: 'text', text: expect.stringContaining('HTTP 422') }])

    msw.use(http.post(FEEDBACK_URL, () => HttpResponse.error()))
    const unreachable = await runSubmitFeedbackTool({ message: 'x' }, 'codemode', FEEDBACK_URL)
    expect(unreachable).toMatchObject({ isError: true })
    expect(unreachable.content).toEqual([
      { type: 'text', text: expect.stringContaining('Nothing was stored') }
    ])
  })
})

describe('submit_feedback over MCP', () => {
  beforeEach(async () => {
    await seedSpec({})
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
  })

  afterEach(async () => {
    Object.assign(env, { FEEDBACK_URL: undefined })
    await clearKv(env.OAUTH_KV)
    await clearSpec()
  })

  it.each([
    ['Code Mode', MCP_URL],
    ['direct mode', `${MCP_URL}?codemode=false`]
  ])('is not offered in %s until a feedback endpoint is configured', async (_mode, url) => {
    const listed = await parseMcpResult(
      await exports.default.fetch(modernMcpRequest('cfat_feedback', 'tools/list', {}, { url }))
    )

    expect(listed.result?.tools?.map((tool) => tool.name)).not.toContain('submit_feedback')
  })

  it.each([
    ['Code Mode', MCP_URL, 'codemode'],
    ['direct mode', `${MCP_URL}?codemode=false`, 'direct']
  ])('is listed and posts the report in %s', async (_mode, url, mode) => {
    Object.assign(env, { FEEDBACK_URL })
    const received: Array<{ body: { fields?: Record<string, string> } }> = []
    acceptFeedback(received)

    const listed = await parseMcpResult(
      await exports.default.fetch(modernMcpRequest('cfat_feedback', 'tools/list', {}, { url }))
    )
    expect(listed.result?.tools?.map((tool) => tool.name)).toContain('submit_feedback')

    const called = await parseMcpResult(
      await exports.default.fetch(
        modernMcpRequest(
          'cfat_feedback',
          'tools/call',
          { name: 'submit_feedback', arguments: { message: 'the D1 tool timed out', type: 'bug' } },
          { url }
        )
      )
    )

    expect(called.result?.isError).toBeUndefined()
    expect(called.result?.structuredContent).toEqual({
      submission_id: expect.stringMatching(UUID)
    })
    expect(received).toHaveLength(1)
    expect(received[0].body.fields).toEqual({ mcp_mode: mode })
  })

  it('refuses arguments outside the schema without posting', async () => {
    Object.assign(env, { FEEDBACK_URL })
    const received: unknown[] = []
    acceptFeedback(received)

    const called = await parseMcpResult(
      await exports.default.fetch(
        modernMcpRequest(
          'cfat_feedback',
          'tools/call',
          { name: 'submit_feedback', arguments: { message: 'x', account_id: ACCOUNT_ID } },
          { url: `${MCP_URL}?codemode=false` }
        )
      )
    )

    expect(called.result?.isError).toBe(true)
    expect(received).toHaveLength(0)
  })
})

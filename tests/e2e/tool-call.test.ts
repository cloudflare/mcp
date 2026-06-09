import { exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from './msw-server'

/**
 * End-to-end test that drives the real worker through the vitest-pool-workers
 * runtime: a JSON-RPC `tools/call` for the `execute` tool runs actual code
 * inside a Worker Loader isolate, whose `cloudflare.request()` is forwarded by
 * the real `GlobalOutbound` service binding.
 *
 * Per the Cloudflare recipes, integration tests invoke the worker via
 * `exports.default.fetch()` (the same instance the pool runs as `main`) and mock
 * outbound `fetch()` declaratively with MSW (`server.use(...)`). MSW intercepts
 * every real outbound call from the worker isolate, so outbound `fetch()` is the
 * ONLY thing mocked; auth, the MCP transport, tool dispatch, Worker Loader and
 * the outbound proxy are all the real code path.
 *
 * https://developers.cloudflare.com/workers/testing/vitest-integration/recipes/
 */

const API_BASE = 'https://api.cloudflare.com/client/v4'
const ACCOUNT_ID = '00000000000000000000000000000001'

// A direct (non-OAuth) API token: NOT 3 colon-separated parts, so the worker
// treats it as a direct Cloudflare API token rather than an OAuth bearer.
const API_TOKEN = 'test-api-token-e2e'

/**
 * Mock the API-token identity guard so the token resolves to a single-account
 * token: `/user` returns no user (account-scoped path), `/accounts` returns
 * exactly one account (pins accountId, so no `account_id` param is needed).
 */
function mockIdentityProbe() {
  server.use(
    http.get(`${API_BASE}/user`, () =>
      HttpResponse.json({ success: false, errors: [], messages: [], result: null })
    ),
    http.get(`${API_BASE}/accounts`, () =>
      HttpResponse.json({
        success: true,
        errors: [],
        messages: [],
        result: [{ id: ACCOUNT_ID, name: 'E2E Test Account' }]
      })
    )
  )
}

function mcpToolCall(name: string, args: Record<string, unknown>): Request {
  return new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      // Streamable HTTP requires the client to accept both content types.
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args }
    })
  })
}

/** Parse a Streamable HTTP response, which may be JSON or an SSE `data:` frame. */
async function parseMcpResult(res: Response): Promise<{
  result?: { content?: Array<{ type: string; text: string }>; isError?: boolean }
  error?: { code: number; message: string }
}> {
  const text = await res.text()
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'))
    return JSON.parse(dataLine!.slice('data:'.length).trim())
  }
  return JSON.parse(text)
}

describe('e2e: execute tool call', () => {
  it('runs code in a Worker Loader isolate and returns the mocked API result', async () => {
    mockIdentityProbe()

    // The Cloudflare API call the executed code makes, forwarded by GlobalOutbound.
    let verifyCalled = false
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/tokens/verify`, () => {
        verifyCalled = true
        return HttpResponse.json({
          success: true,
          errors: [],
          messages: [],
          result: { id: 'token-1', status: 'active' }
        })
      })
    )

    const code = `async () => {
      return await cloudflare.request({
        method: "GET",
        path: "/accounts/${ACCOUNT_ID}/tokens/verify"
      })
    }`

    const res = await exports.default.fetch(mcpToolCall('execute', { code }))

    expect(res.status).toBe(200)

    const json = await parseMcpResult(res)
    expect(json.error).toBeUndefined()
    expect(json.result?.isError).toBeFalsy()

    const responseText = json.result?.content?.[0]?.text ?? ''
    // The executed code returns the cloudflare.request() envelope; assert the
    // mocked result round-tripped all the way back through the isolate.
    expect(responseText).toContain('"status": "active"')
    expect(responseText).toContain('token-1')

    // The forwarded API call really went through GlobalOutbound -> MSW.
    expect(verifyCalled).toBe(true)
  })
})

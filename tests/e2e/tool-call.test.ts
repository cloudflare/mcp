import { exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * End-to-end test that drives the real worker through the vitest-pool-workers
 * runtime: a JSON-RPC `tools/call` for the `execute` tool runs actual code
 * inside a Worker Loader isolate, whose `cloudflare.request()` is forwarded by
 * the real `GlobalOutbound` service binding.
 *
 * Per the Cloudflare recipes, integration tests invoke the worker via
 * `exports.default.fetch()` (the same instance the pool runs as `main`) and mock
 * outbound `fetch()` imperatively with `vi.spyOn(globalThis, 'fetch')`. The spy
 * lives in the test isolate, which is the SAME isolate the main worker (and thus
 * the auth guard and `GlobalOutbound`) runs in — so it intercepts every real
 * outbound call. Outbound `fetch()` is the ONLY thing mocked; auth, the MCP
 * transport, tool dispatch, Worker Loader and the outbound proxy are all real.
 *
 * https://developers.cloudflare.com/workers/testing/vitest-integration/recipes/
 */

const ACCOUNT_ID = '00000000000000000000000000000001'

// A direct (non-OAuth) API token: NOT 3 colon-separated parts, so the worker
// treats it as a direct Cloudflare API token rather than an OAuth bearer.
const API_TOKEN = 'test-api-token-e2e'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

/**
 * Route outbound fetches by URL:
 *  - `/user` -> no user (account-scoped token path)
 *  - `/accounts` -> exactly one account (pins accountId, no param needed)
 *  - `/accounts/{id}/tokens/verify` -> the call the executed code makes,
 *    forwarded by GlobalOutbound
 * Anything else throws, so an unexpected outbound call fails the test loudly.
 */
function installFetchMock() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init)
    const url = new URL(request.url)

    if (url.pathname === '/client/v4/user') {
      return jsonResponse({ success: false, errors: [], messages: [], result: null })
    }
    if (url.pathname === '/client/v4/accounts') {
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: [{ id: ACCOUNT_ID, name: 'E2E Test Account' }]
      })
    }
    if (url.pathname === `/client/v4/accounts/${ACCOUNT_ID}/tokens/verify`) {
      return jsonResponse({
        success: true,
        errors: [],
        messages: [],
        result: { id: 'token-1', status: 'active' }
      })
    }

    throw new Error(`Unexpected outbound fetch: ${request.method} ${request.url}`)
  })
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

let fetchSpy: ReturnType<typeof installFetchMock>

beforeEach(() => {
  fetchSpy = installFetchMock()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('e2e: execute tool call', () => {
  it('runs code in a Worker Loader isolate and returns the mocked API result', async () => {
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

    // The forwarded API call really went through GlobalOutbound's fetch.
    const calledVerify = fetchSpy.mock.calls.some(([input]) =>
      new Request(input as RequestInfo).url.endsWith(`/accounts/${ACCOUNT_ID}/tokens/verify`)
    )
    expect(calledVerify).toBe(true)
  })
})

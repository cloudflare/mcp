import { env } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { API_BASE, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { callTool, toolText } from './helpers/mcp'
import { server } from './setup/msw'

/**
 * Worker-seam tests: drive the real worker entrypoint (`src/index.ts`) end to
 * end through the vitest-pool-workers runtime. A JSON-RPC `tools/call` for the
 * `execute` tool runs actual code inside a Worker Loader isolate, whose
 * `cloudflare.request()` is forwarded by the real `GlobalOutbound` binding.
 *
 * Auth, the MCP transport, tool dispatch, Worker Loader and the outbound proxy
 * are all real. The ONLY mock is outbound `fetch()` (declared with MSW), since
 * we don't want to hit the live Cloudflare API.
 *
 * https://developers.cloudflare.com/workers/testing/vitest-integration/recipes/
 */

const ACCOUNT_ID = '00000000000000000000000000000001'

// A direct (non-OAuth) API token: NOT 3 colon-separated parts, so the worker
// treats it as a direct Cloudflare API token rather than an OAuth bearer.
const API_TOKEN = 'test-api-token-e2e'

afterEach(() => clearKv(env.OAUTH_KV))

describe('worker: execute tool call', () => {
  it('runs code in a Worker Loader isolate and returns the mocked API result', async () => {
    // Real getUserAndAccounts resolves this token to a single-account token.
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'E2E Test Account' }] })

    // The Cloudflare API call the executed code makes, forwarded by GlobalOutbound.
    let verifyCalled = false
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/tokens/verify`, () => {
        verifyCalled = true
        return HttpResponse.json(cfSuccess({ id: 'token-1', status: 'active' }))
      })
    )

    const code = `async () => {
      return await cloudflare.request({
        method: "GET",
        path: "/accounts/${ACCOUNT_ID}/tokens/verify"
      })
    }`

    const result = await callTool(API_TOKEN, 'execute', { code })

    expect(result.error).toBeUndefined()
    expect(result.result?.isError).toBeFalsy()

    const text = toolText(result)
    // The executed code returns the cloudflare.request() envelope; assert the
    // mocked result round-tripped all the way back through the isolate.
    expect(text).toContain('"status": "active"')
    expect(text).toContain('token-1')

    // The forwarded API call really went through GlobalOutbound -> MSW.
    expect(verifyCalled).toBe(true)
  })
})

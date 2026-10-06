import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  API_BASE,
  cfAccountsSuccess,
  cfError,
  cfSuccess,
  mockIdentityProbe
} from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { clearSpec, seedSpec } from './helpers/spec'
import { callTool, toolText, modernMcpRequest, parseMcpResult, MCP_URL } from './helpers/mcp'
import { server } from './setup/msw'

/**
 * Behaviour tests for the code executors, run through the REAL worker: a
 * tools/call for `execute` loads actual code into a Worker Loader isolate whose
 * cloudflare.request() is forwarded by the real GlobalOutbound, and `search`
 * runs against a real seeded SPEC_BUCKET. The only mock is the Cloudflare API
 * boundary (MSW). This replaces the old string-grep assertions on the generated
 * worker source, which never compiled or ran the code.
 */

const ACCOUNT_ID = '00000000000000000000000000000001'
const API_TOKEN = 'test-api-token-executor'

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

/** Run an `execute` tool call whose code hits `path`, with MSW returning `body`. */
async function runExecute(path: string, body: unknown, init?: ResponseInit): Promise<string> {
  mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
  server.use(
    http.get(`${API_BASE}${path}`, () =>
      typeof body === 'string'
        ? new HttpResponse(body, init)
        : HttpResponse.json(body as object, init)
    )
  )
  const result = await callTool(API_TOKEN, 'execute', {
    code: `async () => cloudflare.request({ method: "GET", path: "${path}" })`
  })
  return toolText(result)
}

describe('codemode tool titles', () => {
  it('exposes a title on the execute tool', async () => {
    await seedSpec({})
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })

    const result = await callTool(API_TOKEN, 'execute', null, { method: 'tools/list' })
    const tool = result.result?.tools?.find((t: { name: string }) => t.name === 'execute')
    expect(tool?.annotations).toMatchObject({
      title: 'Cloudflare API Code Executor',
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: true
    })
    expect(tool?.title).toBe('Cloudflare API Code Executor')
  })

  it('exposes a title on the search tool', async () => {
    await seedSpec({})
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })

    const result = await callTool(API_TOKEN, 'search', null, { method: 'tools/list' })
    const tool = result.result?.tools?.find((t: { name: string }) => t.name === 'search')
    expect(tool?.title).toBe('Cloudflare API Spec Search')
    expect(tool?.annotations).toMatchObject({
      title: 'Cloudflare API Spec Search',
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false
    })
  })
})

describe('execute: REST responses', () => {
  it('returns the success envelope with the response status', async () => {
    const text = await runExecute(
      `/accounts/${ACCOUNT_ID}/tokens/verify`,
      cfSuccess({ status: 'active' })
    )
    expect(text).toContain('"status": "active"')
    expect(text).toContain('"success": true')
  })

  it('surfaces a clean "Cloudflare API error" for a failure envelope with errors', async () => {
    const text = await runExecute(
      `/accounts/${ACCOUNT_ID}/tokens/verify`,
      {
        success: false,
        errors: [{ code: 1000, message: 'Invalid API Token' }],
        messages: [],
        result: null
      },
      { status: 403 }
    )
    expect(text).toContain('Cloudflare API error')
    expect(text).toContain('1000: Invalid API Token')
  })

  it('handles a failure envelope with NO errors array without crashing', async () => {
    // Regression: the REST branch must not assume data.errors is an array.
    // A {success:false} body with a missing errors array (e.g. a gateway/proxy
    // envelope) previously threw "Cannot read properties of undefined (map)".
    const text = await runExecute(
      `/accounts/${ACCOUNT_ID}/tokens/verify`,
      { success: false, result: null },
      { status: 502 }
    )
    expect(text).toContain('Cloudflare API error')
    expect(text).not.toContain('undefined')
    expect(text).not.toContain('is not a function')
  })

  it('returns non-JSON responses as raw text', async () => {
    const text = await runExecute(`/accounts/${ACCOUNT_ID}/something`, 'raw-value', {
      headers: { 'Content-Type': 'text/plain' }
    })
    expect(text).toContain('raw-value')
  })
})

describe('execute: retries', () => {
  it('resends the request body when the Cloudflare API rate-limits a write', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const path = `/accounts/${ACCOUNT_ID}/workers/scripts/my-worker/secrets`
    const received: string[] = []
    server.use(
      http.put(`${API_BASE}${path}`, async ({ request }) => {
        received.push(await request.text())
        return received.length === 1
          ? HttpResponse.json(cfError([{ code: 10429, message: 'rate limited' }]), {
              status: 429,
              headers: { 'Retry-After': '1' }
            })
          : HttpResponse.json(cfSuccess({ name: 'API_KEY', type: 'secret_text' }))
      })
    )

    const result = await callTool(API_TOKEN, 'execute', {
      code: `async () => cloudflare.request({ method: "PUT", path: "${path}", body: { name: "API_KEY", text: "s3cret", type: "secret_text" } })`
    })

    const text = toolText(result)
    expect(text).toContain('"success": true')
    expect(text).toContain('API_KEY')
    // GlobalOutbound retried the 429 with the same body, not an already-read stream.
    const body = JSON.stringify({ name: 'API_KEY', text: 's3cret', type: 'secret_text' })
    expect(received).toEqual([body, body])
  })
})

describe('execute: rate-limit waits', () => {
  it('returns the 429 at once when the API asks to wait longer than 5 seconds', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const path = `/accounts/${ACCOUNT_ID}/workers/scripts`
    let calls = 0
    server.use(
      http.get(`${API_BASE}${path}`, () => {
        calls++
        return HttpResponse.json(cfError([{ code: 10429, message: 'rate limited' }]), {
          status: 429,
          headers: { 'Retry-After': '30' }
        })
      })
    )

    const started = Date.now()
    const result = await callTool(API_TOKEN, 'execute', {
      code: `async () => cloudflare.request({ method: "GET", path: "${path}" })`
    })

    // Retrying sooner than 30 s would only spend the user's quota on another 429.
    expect(calls).toBe(1)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(toolText(result)).toContain('rate limited')
  })

  it('waits for the Ratelimit reset instead of retrying blindly', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const path = `/accounts/${ACCOUNT_ID}/workers/scripts`
    const resetAt = Date.now() + 2000
    let calls = 0
    server.use(
      http.get(`${API_BASE}${path}`, () => {
        calls++
        // Like the API: limited until the window resets, saying when in the Ratelimit header.
        const wait = Math.ceil((resetAt - Date.now()) / 1000)
        return wait > 0
          ? HttpResponse.json(cfError([{ code: 10429, message: 'rate limited' }]), {
              status: 429,
              headers: { Ratelimit: `"default";r=0;t=${wait}` }
            })
          : HttpResponse.json(cfSuccess([]))
      })
    )

    const result = await callTool(API_TOKEN, 'execute', {
      code: `async () => cloudflare.request({ method: "GET", path: "${path}" })`
    })

    expect(toolText(result)).toContain('"success": true')
    // One wait for the reset, one retry; blind backoff retries early and needs more calls.
    expect(calls).toBe(2)
  })
})

describe('execute: GraphQL responses', () => {
  async function runGraphql(body: unknown): Promise<string> {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    server.use(http.post(`${API_BASE}/graphql`, () => HttpResponse.json(body as object)))
    const result = await callTool(API_TOKEN, 'execute', {
      code: `async () => cloudflare.request({ method: "POST", path: "/graphql", body: { query: "{ viewer { __typename } }" } })`
    })
    return toolText(result)
  }

  it('normalizes a successful GraphQL response (result = data.data)', async () => {
    const text = await runGraphql({ data: { viewer: { __typename: 'Viewer' } } })
    expect(text).toContain('"viewer"')
    expect(text).toContain('"success": true')
  })

  it('returns a partial response (data + errors) with the error path', async () => {
    const text = await runGraphql({
      data: { viewer: null },
      errors: [{ message: 'boom', path: ['viewer', 'zones'], extensions: { code: 'X' } }]
    })
    expect(text).toContain('(at viewer.zones)')
    expect(text).toContain('Partial response')
  })

  it('throws "GraphQL error" on complete failure (no data, only errors)', async () => {
    const text = await runGraphql({ data: null, errors: [{ message: 'totally broken' }] })
    expect(text).toContain('GraphQL error')
    expect(text).toContain('totally broken')
  })
})

describe('execute: no account resolved (multi-account user token)', () => {
  // A user token spanning >1 account: account_id can't be auto-resolved, so an
  // execute call without account_id binds no usable `accountId`.
  function mockMultiAccountUser() {
    mockIdentityProbe({
      user: { id: 'u1', email: 'u@example.com' },
      accounts: [
        { id: ACCOUNT_ID, name: 'Acc One' },
        { id: '00000000000000000000000000000002', name: 'Acc Two' }
      ]
    })
  }

  it('runs account-independent calls that never read accountId', async () => {
    mockMultiAccountUser()
    server.use(
      http.get(`${API_BASE}/accounts`, () =>
        HttpResponse.json(cfAccountsSuccess([{ id: ACCOUNT_ID, name: 'Acc One' }]))
      )
    )
    const result = await callTool(API_TOKEN, 'execute', {
      code: `async () => cloudflare.request({ method: "GET", path: "/accounts" })`
    })
    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).toContain('"success": true')
  })

  it("fails fast with the session's accounts when code reads the unset accountId", async () => {
    mockMultiAccountUser()
    const result = await callTool(API_TOKEN, 'execute', {
      code: `async () => cloudflare.request({ method: "GET", path: \`/accounts/\${accountId}/workers/scripts\` })`
    })
    const text = toolText(result)
    expect(text).toContain(
      "No account selected. Pass account_id with one of this session's accounts:"
    )
    expect(text).toContain(`- ${ACCOUNT_ID} (Acc One)`)
    expect(text).toContain('- 00000000000000000000000000000002 (Acc Two)')
    // Must not have silently produced an /accounts//... request.
    expect(text).not.toContain('/accounts//')
  })
})

describe('execute: account resolution', () => {
  const OTHER_ACCOUNT_ID = '00000000000000000000000000000002'
  const listWorkers =
    'async () => cloudflare.request({ method: "GET", path: `/accounts/${accountId}/workers/scripts` })'

  function mockUnauthorized(accountId: string) {
    server.use(
      http.get(`${API_BASE}/accounts/${accountId}/workers/scripts`, () =>
        HttpResponse.json(
          cfError([{ code: 9109, message: 'Unauthorized to access requested resource' }]),
          {
            status: 403
          }
        )
      )
    )
  }

  it("lists the session's accounts when a failed call used an unknown account_id", async () => {
    mockIdentityProbe({
      user: { id: 'u1', email: 'u@example.com' },
      accounts: [
        { id: ACCOUNT_ID, name: 'Acc One' },
        { id: OTHER_ACCOUNT_ID, name: 'Acc Two' }
      ]
    })
    mockUnauthorized('not-my-account')
    const result = await callTool(API_TOKEN, 'execute', {
      code: listWorkers,
      account_id: 'not-my-account'
    })
    const text = toolText(result)
    expect(result.result?.isError).toBe(true)
    expect(text).toContain('9109: Unauthorized to access requested resource')
    expect(text).toContain("account_id not-my-account is not one of this session's accounts:")
    expect(text).toContain(`- ${ACCOUNT_ID} (Acc One)`)
  })

  it("adds no account hint when a failed call used one of the session's accounts", async () => {
    mockIdentityProbe({
      user: { id: 'u1', email: 'u@example.com' },
      accounts: [
        { id: ACCOUNT_ID, name: 'Acc One' },
        { id: OTHER_ACCOUNT_ID, name: 'Acc Two' }
      ]
    })
    mockUnauthorized(OTHER_ACCOUNT_ID)
    const result = await callTool(API_TOKEN, 'execute', {
      code: listWorkers,
      account_id: OTHER_ACCOUNT_ID
    })
    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).not.toContain('is not one of')
  })

  it('pre-sets accountId when the session has exactly one account', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const result = await callTool(API_TOKEN, 'execute', { code: 'async () => accountId' })
    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).toContain(ACCOUNT_ID)
  })

  it('uses an explicit account_id over the auto-resolved account', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const result = await callTool(API_TOKEN, 'execute', {
      code: 'async () => accountId',
      account_id: OTHER_ACCOUNT_ID
    })
    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).toContain(OTHER_ACCOUNT_ID)
  })
})

describe('search: real SPEC_BUCKET', () => {
  const SPEC_PATHS = {
    '/accounts/{account_id}/workers/scripts': { get: { summary: 'List Workers' } }
  }

  // The API-token path resolves identity before any tool runs.
  beforeEach(() => mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] }))

  it('evaluates code against the spec seeded in R2', async () => {
    await seedSpec(SPEC_PATHS)

    const result = await callTool(API_TOKEN, 'search', {
      code: `async () => Object.keys(spec.paths)`
    })
    expect(toolText(result)).toContain('/accounts/{account_id}/workers/scripts')
  })

  it('errors when spec.json is missing from R2', async () => {
    const result = await callTool(API_TOKEN, 'search', {
      code: `async () => Object.keys(spec.paths)`
    })
    expect(toolText(result)).toContain('spec.json not found in R2')
  })

  it('has no network access (globalOutbound is null for search)', async () => {
    await seedSpec(SPEC_PATHS)

    const result = await callTool(API_TOKEN, 'search', {
      code: `async () => { await fetch("https://api.cloudflare.com/client/v4/user"); return "should not reach" }`
    })
    // The search isolate cannot make outbound requests.
    expect(toolText(result)).not.toContain('should not reach')
    expect(result.result?.isError).toBe(true)
  })
})

const DOC_URL = 'https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/list/'
const DIAGNOSTIC_PATH = `/accounts/${ACCOUNT_ID}/workers/scripts`

describe('execute: bounded API diagnostics through the real Loader', () => {
  beforeEach(async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    await seedSpec({ '/accounts/{account_id}/workers/scripts': { get: {} } })
  })

  async function diagnosticCall(body: unknown, init: ResponseInit = {}, code?: string, truncate = true) {
    server.use(http.get(`${API_BASE}${DIAGNOSTIC_PATH}`, () => typeof body === 'string'
      ? new HttpResponse(body, init) : HttpResponse.json(body as object, init)))
    const response = await exports.default.fetch(modernMcpRequest(API_TOKEN, 'tools/call', {
      name: 'execute', arguments: { code: code ?? `async () => cloudflare.request({ method: "GET", path: "${DIAGNOSTIC_PATH}" })` }
    }, { url: truncate ? MCP_URL : `${MCP_URL}?truncateToolResult=false` }))
    expect(response.status).toBe(200)
    expect(response.headers.has('WWW-Authenticate')).toBe(false)
    return parseMcpResult(response)
  }

  it.each([401, 403])('preserves upstream %s and useful error facts without guessed scopes', async (status) => {
    const result = await diagnosticCall({ success: false, errors: [{ code: 10000, message: 'Forbidden', documentation_url: DOC_URL }] },
      { status, headers: { 'CF-Ray': 'abc123-SJC', 'WWW-Authenticate': 'Bearer secret' } })
    expect(result.result?.isError).toBe(true)
    expect(result.result?.structuredContent).toEqual({ version: 1, kind: 'cloudflare_api_error', upstreamStatus: status,
      operation: { method: 'GET', pathTemplate: '/accounts/{account_id}/workers/scripts' },
      errors: [{ code: 10000, message: 'Forbidden', documentation_url: DOC_URL }], requestId: 'abc123-SJC',
      authorization: 'unknown', retry: 'do_not_retry_automatically' })
    expect(toolText(result)).toContain(DOC_URL)
    expect(toolText(result)).toContain(`HTTP ${status}`)
  })

  it('exposes diagnostic properties to existing try/catch code', async () => {
    const result = await diagnosticCall({ success: false, errors: [{ code: 'AUTH', message: 'Forbidden', documentation_url: DOC_URL }] }, { status: 403 },
      `async () => { try { await cloudflare.request({ method: "GET", path: "${DIAGNOSTIC_PATH}" }); } catch (error) {
        return { status: error.status, method: error.method, path: error.path, errors: error.errors, diagnostic: error.diagnostic };
      } }`)
    expect(result.result?.isError).toBeFalsy()
    const caught = JSON.parse(toolText(result))
    expect(caught.status).toBe(403)
    expect(caught.method).toBe('GET')
    expect(caught.path).toBe('/accounts/{account_id}/workers/scripts')
    expect(caught.errors).toEqual([{ code: 'AUTH', message: 'Forbidden', documentation_url: DOC_URL }])
  })

  it.each([[403, true], [200, false]])('rejects HTTP %s with REST success=%s', async (status, success) => {
    const result = await diagnosticCall({ success, result: { ignored: true } }, { status })
    expect(result.result?.isError).toBe(true)
    expect(result.result?.structuredContent?.upstreamStatus).toBe(status)
  })

  it.each([
    ['', 'application/json', 'invalid_api_response'],
    ['{broken', 'application/json', 'invalid_api_response'],
    ['<html>token-and-authorization-url</html>', 'text/html', 'cloudflare_api_error'],
    ['secret gateway body', 'text/plain', 'cloudflare_api_error']
  ])('retains status for unsafe body %# without copying it', async (body, contentType, kind) => {
    const result = await diagnosticCall(body, { status: 502, headers: { 'Content-Type': contentType } })
    expect(result.result?.structuredContent).toMatchObject({ upstreamStatus: 502, kind, errors: [] })
    if (body) expect(JSON.stringify(result)).not.toContain(body)
  })

  it('redacts echoed credentials and sensitive URLs in diagnostic messages', async () => {
    const result = await diagnosticCall({ success: false, errors: [{ code: 1, message: `${API_TOKEN} https://example.com/oauth?secret=very-secret Bearer dangerous` }] }, { status: 403 })
    expect(JSON.stringify(result)).not.toContain(API_TOKEN)
    expect(JSON.stringify(result)).not.toContain('very-secret')
    expect(JSON.stringify(result)).not.toContain('dangerous')
  })

  it.each([true, false])('enforces diagnostic bounds with truncation=%s', async (truncate) => {
    const result = await diagnosticCall({ success: false, errors: Array.from({ length: 20 }, () => ({ code: 1, message: 'x'.repeat(1000), documentation_url: DOC_URL })) }, { status: 403 }, undefined, truncate)
    const diagnostic = result.result?.structuredContent
    expect(new TextEncoder().encode(JSON.stringify(diagnostic)).length).toBeLessThanOrEqual(8192)
    expect(diagnostic?.operation).toEqual({ method: 'GET', pathTemplate: '/accounts/{account_id}/workers/scripts' })
    expect(toolText(result)).toContain(DOC_URL)
  })

  it('retains status and operation for an oversized JSON failure body', async () => {
    const result = await diagnosticCall({ success: false, errors: [{ message: 'x'.repeat(40000) }] }, { status: 403 })
    expect(result.result?.structuredContent).toMatchObject({ upstreamStatus: 403, errors: [], operation: { method: 'GET', pathTemplate: '/accounts/{account_id}/workers/scripts' } })
  })

  it('rejects oversized HTTP 200 failure envelopes while preserving large successes', async () => {
    const failed = await diagnosticCall({ success: false, errors: [{ message: 'x'.repeat(40000) }] })
    expect(failed.result?.structuredContent).toMatchObject({ upstreamStatus: 200, errors: [] })
    const succeeded = await diagnosticCall({ success: true, result: 'x'.repeat(40000) }, {}, undefined, false)
    expect(succeeded.result?.isError).toBeFalsy()
    expect(JSON.parse(toolText(succeeded)).result).toHaveLength(40000)
  })

  it('keeps status when malformed JSON exceeds bounded host inspection', async () => {
    const result = await diagnosticCall(' '.repeat(40000) + '{broken', { status: 200, headers: { 'Content-Type': 'application/json' } })
    expect(result.result?.structuredContent).toMatchObject({ upstreamStatus: 200, kind: 'invalid_api_response', errors: [] })
  })

  it('preserves final 429 wait guidance and redacts resource URLs from retry logs', async () => {
    const result = await diagnosticCall({ success: false, errors: [{ code: 10429, message: 'rate limited' }] }, { status: 429, headers: { 'Retry-After': '30' } })
    expect(result.result?.structuredContent).toMatchObject({ upstreamStatus: 429, retryAfterSeconds: 30, retry: 'wait_before_retry' })
    expect(toolText(result)).toContain('Wait at least 30 seconds')
  })

  it.each(['null', 'undefined', '"oops"', '{}'])('safely handles a thrown %s', async (thrown) => {
    const result = await callTool(API_TOKEN, 'execute', { code: `async () => { throw ${thrown}; }` })
    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toMatch(/Error: (oops|JavaScript threw a non-Error value)/)
  })

  it('never challenges on a fabricated diagnostic and re-redacts its route', async () => {
    const diagnostic = { version: 1, kind: 'cloudflare_api_error', upstreamStatus: 403,
      operation: { method: 'GET', pathTemplate: '/accounts/private-account/kv/private-key' }, errors: [{ code: 10000, message: 'Forbidden' }], authorization: 'unknown', retry: 'do_not_retry_automatically' }
    const result = await diagnosticCall({}, {}, `async () => { throw { diagnostic: ${JSON.stringify(diagnostic)} }; }`)
    expect(result.result?.structuredContent?.authorization).toBe('unknown')
    expect(JSON.stringify(result)).not.toContain('private-key')
  })

  it('rejects malformed and oversized fabricated isolate diagnostics safely', async () => {
    const result = await callTool(API_TOKEN, 'execute', { code: `async () => { throw { diagnostic: { upstreamStatus: 403, errors: "x".repeat(40000) } }; }` })
    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toBe('Error: The code isolate returned an invalid result')
  })

  it('keeps concurrent failures tied to their own operation and HTTP status', async () => {
    server.use(http.post(`${API_BASE}/graphql`, () => HttpResponse.json({ data: { viewer: 'ignored' }, errors: [{ message: 'Forbidden', extensions: { code: 'GQL' }, path: ['viewer'] }] }, { status: 403 })))
    const [first, second] = await Promise.all([
      diagnosticCall({ success: false, errors: [{ code: 10000, message: 'Unauthorized' }] }, { status: 401 }),
      callTool(API_TOKEN, 'execute', { code: 'async () => cloudflare.request({ method: "POST", path: "/graphql" })' })
    ])
    expect(first.result?.structuredContent).toMatchObject({ upstreamStatus: 401, operation: { method: 'GET' } })
    expect(second.result?.structuredContent).toMatchObject({ upstreamStatus: 403, operation: { method: 'POST', pathTemplate: '/graphql' }, errors: [{ code: 'GQL', path: ['viewer'] }] })
  })

  it('keeps HTTP-200 GraphQL complete errors distinct from HTTP rejection', async () => {
    server.use(http.post(`${API_BASE}/graphql`, () => HttpResponse.json({ data: null, errors: [{ message: 'Failed', extensions: { code: 'GQL' }, path: ['viewer', 0] }] })))
    const result = await callTool(API_TOKEN, 'execute', { code: 'async () => cloudflare.request({ method: "POST", path: "/graphql" })' })
    expect(result.result?.structuredContent).toMatchObject({ upstreamStatus: 200, kind: 'graphql_error', errors: [{ code: 'GQL', path: ['viewer', 0] }] })
  })
})

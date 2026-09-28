import { env } from 'cloudflare:workers'
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
import { callTool, toolText } from './helpers/mcp'
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

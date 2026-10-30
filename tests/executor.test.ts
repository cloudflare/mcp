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

  it('preserves the error code and Ray ID when an error has no message', async () => {
    const text = await runExecute(
      `/accounts/${ACCOUNT_ID}/access/apps`,
      { success: false, errors: [{ code: 1010 }] },
      { status: 400, headers: { 'cf-ray': 'test-ray-id' } }
    )
    expect(text).toContain('1010: Cloudflare returned an error without a message')
    expect(text).toContain('Cloudflare Ray ID: test-ray-id')
    expect(text).not.toContain('undefined')
  })

  it('uses the envelope message when an error message is empty', async () => {
    const text = await runExecute(
      `/accounts/${ACCOUNT_ID}/access/apps`,
      {
        success: false,
        errors: [{ code: 1010, message: '' }],
        messages: [{ message: 'Access application policy was rejected' }]
      },
      { status: 400 }
    )
    expect(text).toContain('1010: Access application policy was rejected')
    expect(text).not.toContain('undefined')
  })

  it('redacts credentials and email addresses from API error details', async () => {
    const text = await runExecute(
      `/accounts/${ACCOUNT_ID}/access/apps`,
      {
        success: false,
        errors: [
          {
            code: 1010,
            message: 'Policy rejected for owner@example.com; api_token=secret-value'
          }
        ]
      },
      { status: 400 }
    )
    expect(text).toContain('1010: Policy rejected for [REDACTED_EMAIL]; api_token=[REDACTED]')
    expect(text).not.toContain('owner@example.com')
    expect(text).not.toContain('secret-value')
  })

  it('returns non-JSON responses as raw text', async () => {
    const text = await runExecute(`/accounts/${ACCOUNT_ID}/something`, 'raw-value', {
      headers: { 'Content-Type': 'text/plain' }
    })
    expect(text).toContain('raw-value')
  })

  it.each(['GET', 'POST'])('returns default SQL JSON through %s', async (method) => {
    const body = {
      meta: [{ name: 'value', type: 'UInt64' }],
      data: [{ value: '1' }],
      rows: 1,
      statistics: { elapsed: 0.01, rows_read: 1, bytes_read: 8 }
    }
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    server.use(http.all(`${API_BASE}/analytics/sql`, () => HttpResponse.json(body)))
    const result = await callTool(API_TOKEN, 'execute', {
      code: `async () => cloudflare.request({
        method: ${JSON.stringify(method)}, path: "/analytics/sql",
        ${method === 'POST' ? 'body' : 'query'}: { query: "SELECT 1 AS value" }
      })`
    })
    expect(result.result?.isError).toBeFalsy()
    expect(JSON.parse(toolText(result))).toEqual({ success: true, status: 200, result: body })
  })

  it.each([
    { name: 'array', body: [{ id: 'one' }] },
    { name: 'null', body: null },
    { name: 'boolean', body: false },
    { name: 'number', body: 42 },
    { name: 'string', body: 'value' },
    { name: 'empty object', body: {} },
    { name: 'domain fields', body: { success: 0, status: 'ready', result: [1], errors: [] } }
  ])('preserves a direct JSON $name as result', async ({ body }) => {
    const text = await runExecute('/direct-json', JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' }
    })
    expect(JSON.parse(text)).toEqual({ success: true, status: 200, result: body })
  })

  it.each(['application/scim+json', 'Application/SCIM+JSON; charset=utf-8'])(
    'keeps %s results structured',
    async (contentType) => {
      const body = { Resources: [{ id: 'g1', displayName: 'Admins' }], totalResults: 1 }
      const text = await runExecute('/scim/Groups', body, {
        headers: { 'Content-Type': contentType }
      })
      expect(JSON.parse(text)).toEqual({ success: true, status: 200, result: body })
    }
  )

  it('preserves all fields of a traditional success envelope', async () => {
    const body = {
      ...cfSuccess([{ id: 'one' }]),
      result_info: { page: 1, total_pages: 2 },
      extra: { retained: true }
    }
    const text = await runExecute('/envelope', body, { status: 201 })
    expect(JSON.parse(text)).toEqual({ ...body, status: 201 })
  })

  it('rejects an explicit failure envelope even with HTTP 200', async () => {
    const text = await runExecute('/envelope', cfError([{ code: 1000, message: 'Denied' }]))
    expect(text).toContain('Cloudflare API error: GET /envelope returned HTTP 200: 1000: Denied')
  })

  it.each([
    { name: 'success envelope', body: cfSuccess([]) },
    { name: 'direct object', body: { message: 'Denied' } },
    { name: 'null', body: null }
  ])('rejects HTTP failures with a $name body', async ({ body }) => {
    const text = await runExecute('/failure', body, { status: 403 })
    expect(text).toContain('Cloudflare API error: GET /failure returned HTTP 403')
  })

  it('preserves the JSONEachRow workaround as text', async () => {
    const body = '{"value":"1"}\n'
    const text = await runExecute('/analytics/sql', body, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })
    expect(JSON.parse(text)).toEqual({ success: true, status: 200, result: body })
  })
})

describe('execute: request bodies', () => {
  const PATH = '/accounts/' + ACCOUNT_ID + '/body'

  /** Run `request`, the options cloudflare.request() gets, and return what the API received. */
  async function sent(request: string) {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    let received: { contentType: string | null; bytes: Uint8Array; form?: FormData } | undefined
    server.use(
      http.all(`${API_BASE}${PATH}`, async ({ request: req }) => {
        const contentType = req.headers.get('content-type')
        const form = contentType?.startsWith('multipart/form-data')
          ? await req.clone().formData()
          : undefined
        received = { contentType, bytes: new Uint8Array(await req.arrayBuffer()), form }
        return HttpResponse.json(cfSuccess({}))
      })
    )
    const result = await callTool(API_TOKEN, 'execute', {
      code: `async () => cloudflare.request({ method: "POST", path: "${PATH}", ${request} })`
    })
    expect(result.result?.isError, toolText(result)).toBeFalsy()
    if (!received) throw new Error('The API received no request')
    return { ...received, text: new TextDecoder().decode(received.bytes) }
  }

  it.each([
    ['an object', 'body: { name: "a" }', '{"name":"a"}'],
    ['an array', 'body: [{ id: 1 }]', '[{"id":1}]'],
    ['a number', 'body: 3', '3'],
    ['a string that is already JSON', `body: JSON.stringify({ name: "a" })`, '{"name":"a"}'],
    // Zaraz's publish and workflow endpoints take a bare JSON string.
    ['any other string', 'body: "realtime"', '"realtime"']
  ])('sends %s as JSON', async (_, request, expected) => {
    const { contentType, text } = await sent(request)
    expect(contentType).toBe('application/json')
    expect(text).toBe(expected)
  })

  it('keeps an explicit JSON content type, such as merge-patch', async () => {
    const { contentType, text } = await sent(
      'body: { a: null }, contentType: "application/merge-patch+json"'
    )
    expect(contentType).toBe('application/merge-patch+json')
    expect(text).toBe('{"a":null}')
  })

  it.each([
    ['SQL as text/plain', 'text/plain', 'SELECT 1'],
    ['NDJSON', 'application/x-ndjson', '{"id":"a"}\n{"id":"b"}'],
    ['JSON Lines', 'application/jsonl', '{"id":"a"}'],
    ['a script', 'application/javascript', 'export default {}']
  ])('sends %s as it is', async (_, type, body) => {
    const { contentType, text } = await sent(
      `body: ${JSON.stringify(body)}, contentType: ${JSON.stringify(type)}`
    )
    expect(contentType).toBe(type)
    expect(text).toBe(body)
  })

  it('sends bytes as they are', async () => {
    const { contentType, bytes } = await sent(
      'body: new Uint8Array([0, 255, 128, 10]), contentType: "application/octet-stream"'
    )
    expect(contentType).toBe('application/octet-stream')
    expect([...bytes]).toEqual([0, 255, 128, 10])
  })

  it('sends FormData with its multipart boundary, even when the content type omits it', async () => {
    const { contentType, form } = await sent(`body: (() => {
      const form = new FormData();
      form.append("metadata", new Blob(['{"main_module":"worker.js"}'], { type: "application/json" }));
      form.append("worker.js", new Blob(["export default {}"], { type: "application/javascript+module" }), "worker.js");
      return form;
    })(), contentType: "multipart/form-data"`)
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(await (form?.get('metadata') as Blob).text()).toBe('{"main_module":"worker.js"}')
    expect(await (form?.get('worker.js') as Blob).text()).toBe('export default {}')
  })

  it('still sends a string as it is with rawBody, for code written against older descriptions', async () => {
    const { contentType, text } = await sent('body: "plain value", rawBody: true')
    expect(contentType).toBe('text/plain;charset=UTF-8')
    expect(text).toBe('plain value')
  })
})

describe('execute: binary responses', () => {
  // A JPEG's first bytes: invalid UTF-8, so decoding them as text loses them (#322).
  const JPEG = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x80, 0xfe
  ])
  const PATH = '/accounts/' + ACCOUNT_ID + '/r2/buckets/b/objects/photo.jpg'

  function serve(type: string) {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    server.use(
      http.get(
        `${API_BASE}${PATH}`,
        () => new HttpResponse(JPEG, { headers: { 'Content-Type': type } })
      )
    )
  }

  it.each(['image/jpeg', 'application/octet-stream', 'application/pdf', ''])(
    'returns %s as lossless bytes',
    async (type) => {
      serve(type)
      const result = await callTool(API_TOKEN, 'execute', {
        code: `async () => cloudflare.request({ method: "GET", path: "${PATH}" })`
      })
      const { result: bytes } = JSON.parse(toolText(result))
      expect(bytes).toEqual({ base64: btoa(String.fromCharCode(...JPEG)), byteLength: JPEG.length })
    }
  )

  it('gives the code a Uint8Array it can use', async () => {
    serve('image/jpeg')
    const result = await callTool(API_TOKEN, 'execute', {
      code: `async () => {
        const { result } = await cloudflare.request({ method: "GET", path: "${PATH}" });
        return { isBytes: result instanceof Uint8Array, first: result[0], length: result.length };
      }`
    })
    expect(JSON.parse(toolText(result))).toEqual({
      isBytes: true,
      first: 0xff,
      length: JPEG.length
    })
  })

  it('returns a UTF-8 KV value served as application/octet-stream as text', async () => {
    const text = await runExecute(
      `/accounts/${ACCOUNT_ID}/storage/kv/namespaces/ns/values/k`,
      'hello, kv ✓',
      {
        headers: { 'Content-Type': 'application/octet-stream' }
      }
    )
    expect(JSON.parse(text).result).toBe('hello, kv ✓')
  })

  it('returns an image as bytes even when they are valid UTF-8', async () => {
    const text = await runExecute(`/accounts/${ACCOUNT_ID}/images/v1/i/blob`, 'GIF89a', {
      headers: { 'Content-Type': 'image/gif' }
    })
    expect(JSON.parse(text).result).toEqual({ base64: btoa('GIF89a'), byteLength: 6 })
  })

  it.each(['text/csv', 'application/xml', 'application/x-ndjson', 'application/x-pem-file'])(
    'still returns %s as text',
    async (type) => {
      const text = await runExecute(`/accounts/${ACCOUNT_ID}/export`, 'a,b\n1,2', {
        headers: { 'Content-Type': type }
      })
      expect(JSON.parse(text).result).toBe('a,b\n1,2')
    }
  )
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

describe('search: the pinned spec, in the forge tools service', () => {
  // The API-token path resolves identity before any tool runs.
  beforeEach(() => mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] }))

  it('evaluates code against the pinned spec', async () => {
    const result = await callTool(API_TOKEN, 'search', {
      code: `async () => spec.paths['/accounts/{account_id}/workers/scripts'].get.summary`
    })
    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).toContain('List Worker Scripts')
  })

  it("returns the code's error as the tool's error", async () => {
    const result = await callTool(API_TOKEN, 'search', {
      code: `async () => { throw new Error('no such product') }`
    })
    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toContain('no such product')
  })

  it('has no network access (globalOutbound is null for search)', async () => {
    const result = await callTool(API_TOKEN, 'search', {
      code: `async () => { await fetch("https://api.cloudflare.com/client/v4/user"); return "should not reach" }`
    })
    // The search isolate cannot make outbound requests.
    expect(toolText(result)).not.toContain('should not reach')
    expect(result.result?.isError).toBe(true)
  })
})

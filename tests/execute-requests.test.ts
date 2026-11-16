import { env } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { API_BASE, cfError, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { clearSpec } from './helpers/spec'
import { callTool, toolText } from './helpers/mcp'
import { server } from './setup/msw'

/**
 * What `cloudflare.request()` puts on the wire, for every kind of request the
 * OpenAPI spec declares: each header parameter and each request media type.
 * The paths, headers and media types are the pinned spec's (`openapi@…` in
 * `src/generated/forge-mcp/source.json`).
 *
 * Run through the real worker: `execute` loads the code into a Worker Loader
 * isolate and the real GlobalOutbound forwards it. MSW stands in for the
 * Cloudflare API and records what it received.
 */

const ACCOUNT = '00000000000000000000000000000001'
const ZONE = '00000000000000000000000000000002'
const API_TOKEN = 'test-api-token-execute-requests'

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

/** A request the API received. */
type Received = {
  method: string
  path: string
  query: URLSearchParams
  headers: Headers
  bytes: Uint8Array
  text: string
}

type Respond = (received: Received, count: number) => Response

/**
 * Run `code` in `execute`. Every request it makes to the API is recorded and
 * answered by `respond`, or with an empty success envelope.
 */
async function run(code: string, respond: Respond = () => HttpResponse.json(cfSuccess({}))) {
  const received: Received[] = []
  server.use(
    http.all(`${API_BASE}/*`, async ({ request }) => {
      const url = new URL(request.url)
      const bytes = new Uint8Array(await request.arrayBuffer())
      const one = {
        method: request.method,
        path: url.pathname.slice(new URL(API_BASE).pathname.length),
        query: url.searchParams,
        headers: new Headers(request.headers),
        bytes,
        text: new TextDecoder().decode(bytes)
      }
      received.push(one)
      return respond(one, received.length)
    })
  )
  // Registered last, so the identity probe's GET /user and GET /accounts win.
  mockIdentityProbe({ accounts: [{ id: ACCOUNT, name: 'Acc' }] })
  const result = await callTool(API_TOKEN, 'execute', { code })
  return { received, text: toolText(result), isError: Boolean(result.result?.isError) }
}

/** Run one `cloudflare.request({ <options> })` that must succeed, and return what the API received. */
async function send(options: string, respond?: Respond): Promise<Received> {
  const { received, text, isError } = await run(
    `async () => cloudflare.request({ ${options} })`,
    respond
  )
  expect(isError, text).toBe(false)
  expect(received).toHaveLength(1)
  return received[0]
}

/** The parts of a multipart body, read as the API would. */
async function formOf({ headers, bytes }: Received): Promise<FormData> {
  return new Response(bytes, {
    headers: { 'Content-Type': headers.get('content-type') ?? '' }
  }).formData()
}

describe('execute: header parameters the spec declares', () => {
  // One operation for each of the spec's 23 header parameter names.
  it.each([
    [
      'cf-r2-jurisdiction',
      'GET',
      `/accounts/${ACCOUNT}/r2/buckets`,
      { 'cf-r2-jurisdiction': 'eu' }
    ],
    [
      'cf-r2-storage-class',
      'PUT',
      `/accounts/${ACCOUNT}/r2/buckets/b`,
      { 'cf-r2-storage-class': 'InfrequentAccess' }
    ],
    [
      'cf-r2-data-catalog-check',
      'POST',
      `/accounts/${ACCOUNT}/r2/buckets/b/jobs`,
      { 'cf-r2-data-catalog-check': 'true' }
    ],
    [
      'If-Match',
      'PUT',
      `/accounts/${ACCOUNT}/billing/spend-policies/p1`,
      { 'If-Match': '"etag-1"' }
    ],
    [
      'If-None-Match',
      'GET',
      `/accounts/${ACCOUNT}/flagship/apps/a1/definitions`,
      { 'If-None-Match': '"etag-1"' }
    ],
    [
      'If-Modified-Since',
      'GET',
      `/accounts/${ACCOUNT}/r2/buckets/b/objects/k`,
      { 'If-Modified-Since': 'Wed, 21 Oct 2026 07:28:00 GMT' }
    ],
    [
      'Idempotency-Key',
      'POST',
      '/accounts',
      { 'Idempotency-Key': '2f1c7b1e-8a3d-4e6f-9b0a-1c2d3e4f5a6b' }
    ],
    [
      'Prefer',
      'POST',
      `/accounts/${ACCOUNT}/registrar-sandbox/registrations`,
      { Prefer: 'respond-async' }
    ],
    [
      'accept',
      'GET',
      `/accounts/${ACCOUNT}/cloudforce-one/v2/collections/c1/export`,
      { accept: 'application/stix+json' }
    ],
    ['Accept', 'GET', '/organizations/o1/accounts', { Accept: 'application/json' }],
    [
      'Cf-Async-Upload',
      'PUT',
      `/accounts/${ACCOUNT}/intel/indicator-feeds/7/snapshot`,
      { 'Cf-Async-Upload': 'true' }
    ],
    [
      'R2-Access-Key-Id and R2-Secret-Access-Key',
      'GET',
      `/accounts/${ACCOUNT}/logs/list`,
      { 'R2-Access-Key-Id': '29a92f1a6e6887d79f3401a41', 'R2-Secret-Access-Key': '869b6e19534a' }
    ],
    [
      'x-magic-new-hc-target',
      'GET',
      `/accounts/${ACCOUNT}/magic/cf_interconnects`,
      { 'x-magic-new-hc-target': 'true' }
    ],
    [
      'Tus-Resumable, Upload-Length, Upload-Creator and Upload-Metadata',
      'POST',
      `/accounts/${ACCOUNT}/stream`,
      {
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '1048576',
        'Upload-Creator': 'creator-id_abcde12345',
        'Upload-Metadata': 'name aGVsbG8gd29ybGQ=, requiresignedurls'
      }
    ],
    [
      'CF-WORKER-BODY-PART and CF-WORKER-MAIN-MODULE-PART',
      'PUT',
      `/accounts/${ACCOUNT}/workers/scripts/s/content`,
      { 'CF-WORKER-BODY-PART': 'worker.js', 'CF-WORKER-MAIN-MODULE-PART': 'worker.js' }
    ],
    [
      'api-version',
      'PATCH',
      `/accounts/${ACCOUNT}/workers/dispatch/namespaces/n/scripts/s/tags/t`,
      { 'api-version': '2' }
    ]
  ])('sends %s', async (_, method, path, headers) => {
    const received = await send(
      `method: ${JSON.stringify(method)}, path: ${JSON.stringify(path)}, headers: ${JSON.stringify(headers)}`
    )
    expect(received.method).toBe(method)
    expect(received.path).toBe(path)
    for (const [name, value] of Object.entries(headers)) {
      expect(received.headers.get(name), name).toBe(value)
    }
    // No body, so no Content-Type is made up for it.
    expect(received.headers.get('content-type')).toBeNull()
    expect(received.bytes).toHaveLength(0)
  })

  it('sends Content-Type and Content-Length with an R2 object upload', async () => {
    const received = await send(
      `method: "PUT", path: "/accounts/${ACCOUNT}/r2/buckets/b/objects/photo.jpg",
       headers: { "Content-Type": "image/jpeg", "cf-r2-jurisdiction": "eu", "cf-r2-storage-class": "Standard" },
       body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0])`
    )
    expect(received.headers.get('content-type')).toBe('image/jpeg')
    expect(received.headers.get('content-length')).toBe('4')
    expect(received.headers.get('cf-r2-jurisdiction')).toBe('eu')
    expect(received.headers.get('cf-r2-storage-class')).toBe('Standard')
    expect([...received.bytes]).toEqual([0xff, 0xd8, 0xff, 0xe0])
  })

  it('sends headers, query and a JSON body together', async () => {
    const received = await send(
      `method: "POST", path: "/accounts/${ACCOUNT}/r2/buckets",
       query: { cursor: "c1", per_page: 20, skipped: undefined },
       headers: { "cf-r2-jurisdiction": "eu" },
       body: { name: "backups", storageClass: "Standard" }`
    )
    expect(Object.fromEntries(received.query)).toEqual({ cursor: 'c1', per_page: '20' })
    expect(received.headers.get('cf-r2-jurisdiction')).toBe('eu')
    expect(received.headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(received.text)).toEqual({ name: 'backups', storageClass: 'Standard' })
  })
})

describe('execute: R2 buckets in a jurisdiction (#278)', () => {
  const BUCKETS = `/accounts/${ACCOUNT}/r2/buckets`
  // Like the API: a bucket exists only in its jurisdiction.
  const r2: Respond = ({ path, headers }) => {
    const eu = headers.get('cf-r2-jurisdiction') === 'eu'
    if (path === BUCKETS) {
      return HttpResponse.json(
        cfSuccess({ buckets: eu ? [{ name: 'backups', jurisdiction: 'eu' }] : [] })
      )
    }
    return eu
      ? HttpResponse.json(cfSuccess({ name: 'backups', jurisdiction: 'eu' }))
      : HttpResponse.json(
          cfError([{ code: 10006, message: 'The specified bucket does not exist.' }]),
          { status: 404 }
        )
  }

  it('lists no buckets without the header, and the EU buckets with it', async () => {
    const { text } = await run(
      `async () => {
        const without = await cloudflare.request({ method: "GET", path: "${BUCKETS}" });
        const withEu = await cloudflare.request({ method: "GET", path: "${BUCKETS}", headers: { "cf-r2-jurisdiction": "eu" } });
        return { without: without.result.buckets, withEu: withEu.result.buckets };
      }`,
      r2
    )
    expect(JSON.parse(text)).toEqual({
      without: [],
      withEu: [{ name: 'backups', jurisdiction: 'eu' }]
    })
  })

  it('reads an EU bucket with the header, and gets 10006 without it', async () => {
    const found = await run(
      `async () => cloudflare.request({ method: "GET", path: "${BUCKETS}/backups", headers: { "cf-r2-jurisdiction": "eu" } })`,
      r2
    )
    expect(JSON.parse(found.text).result).toEqual({ name: 'backups', jurisdiction: 'eu' })

    const missing = await run(
      `async () => cloudflare.request({ method: "GET", path: "${BUCKETS}/backups" })`,
      r2
    )
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain(`GET ${BUCKETS}/backups returned HTTP 404`)
    expect(missing.text).toContain('"code": 10006')
  })
})

describe('execute: how headers are sent', () => {
  const PATH = `/accounts/${ACCOUNT}/r2/buckets`

  it("always sends the session's token, whatever Authorization the code names", async () => {
    const received = await send(
      `method: "GET", path: "${PATH}", headers: { Authorization: "Bearer someone-else", "cf-r2-jurisdiction": "eu" }`
    )
    expect(received.headers.get('authorization')).toBe(`Bearer ${API_TOKEN}`)
    expect(received.headers.get('cf-r2-jurisdiction')).toBe('eu')
  })

  it("always sends the session's token for a request the code makes with fetch", async () => {
    const { received } = await run(
      `async () => {
        const response = await fetch(${JSON.stringify(API_BASE + PATH)}, { headers: { authorization: "Bearer someone-else" } });
        return response.status;
      }`
    )
    expect(received[0].headers.get('authorization')).toBe(`Bearer ${API_TOKEN}`)
  })

  it('leaves out a header whose value is undefined or null', async () => {
    const received = await send(
      `method: "GET", path: "${PATH}", headers: { "cf-r2-jurisdiction": undefined, "If-None-Match": null, Prefer: "respond-async" }`
    )
    expect(received.headers.get('cf-r2-jurisdiction')).toBeNull()
    expect(received.headers.get('if-none-match')).toBeNull()
    expect(received.headers.get('prefer')).toBe('respond-async')
  })

  it('sends a number or boolean value as text', async () => {
    const received = await send(
      `method: "POST", path: "/accounts/${ACCOUNT}/stream", headers: { "Upload-Length": 1048576, "Cf-Async-Upload": true }`
    )
    expect(received.headers.get('upload-length')).toBe('1048576')
    expect(received.headers.get('cf-async-upload')).toBe('true')
  })

  it('accepts a Headers object', async () => {
    const received = await send(
      `method: "GET", path: "${PATH}", headers: new Headers({ "cf-r2-jurisdiction": "eu" })`
    )
    expect(received.headers.get('cf-r2-jurisdiction')).toBe('eu')
  })

  it('reads header names without regard to case', async () => {
    const received = await send(
      `method: "POST", path: "/accounts/${ACCOUNT}/analytics/sql", headers: { "content-type": "text/plain" }, body: "SELECT 1"`
    )
    expect(received.headers.get('content-type')).toBe('text/plain')
    expect(received.text).toBe('SELECT 1')
  })

  it('fails the call for a header name that is not one', async () => {
    const { received, text, isError } = await run(
      `async () => cloudflare.request({ method: "GET", path: "${PATH}", headers: { "not a header": "x" } })`
    )
    expect(isError).toBe(true)
    expect(text).toMatch(/header/i)
    expect(received).toHaveLength(0)
  })

  it('sends the headers again when a rate-limited request is retried', async () => {
    const { received, isError, text } = await run(
      `async () => cloudflare.request({ method: "PUT", path: "${PATH}/b/lifecycle", headers: { "cf-r2-jurisdiction": "eu" }, body: { rules: [] } })`,
      (_, count) =>
        count === 1
          ? HttpResponse.json(cfError([{ code: 10429, message: 'rate limited' }]), {
              status: 429,
              headers: { 'Retry-After': '1' }
            })
          : HttpResponse.json(cfSuccess({}))
    )
    expect(isError, text).toBe(false)
    expect(received.map((one) => one.headers.get('cf-r2-jurisdiction'))).toEqual(['eu', 'eu'])
    expect(received.map((one) => one.text)).toEqual(['{"rules":[]}', '{"rules":[]}'])
  })
})

describe('execute: request bodies, by the media types the spec declares', () => {
  const post = (path: string, rest: string) => send(`method: "POST", path: "${path}", ${rest}`)

  it('application/json: an object', async () => {
    const received = await post(`/accounts/${ACCOUNT}/d1/database`, 'body: { name: "db" }')
    expect(received.headers.get('content-type')).toBe('application/json')
    expect(received.text).toBe('{"name":"db"}')
  })

  it('application/json: an array', async () => {
    const received = await post(
      `/accounts/${ACCOUNT}/storage/kv/namespaces/ns/bulk/delete`,
      'body: ["a", "b"]'
    )
    expect(received.headers.get('content-type')).toBe('application/json')
    expect(received.text).toBe('["a","b"]')
  })

  it('application/json: an integer, as Zaraz history takes', async () => {
    const received = await send(
      `method: "PUT", path: "/zones/${ZONE}/settings/zaraz/history", body: 12345`
    )
    expect(received.headers.get('content-type')).toBe('application/json')
    expect(received.text).toBe('12345')
  })

  it('application/json: a boolean', async () => {
    const received = await post(`/accounts/${ACCOUNT}/json`, 'body: false')
    expect(received.headers.get('content-type')).toBe('application/json')
    expect(received.text).toBe('false')
  })

  it('application/json: a JSON string value, as Zaraz publish takes, stringified by the code', async () => {
    const received = await post(
      `/zones/${ZONE}/settings/zaraz/publish`,
      'body: JSON.stringify("Config with enabled ecommerce tracking")'
    )
    expect(received.headers.get('content-type')).toBe('application/json')
    expect(received.text).toBe('"Config with enabled ecommerce tracking"')
  })

  it('application/json: an object the code stringified itself', async () => {
    const received = await post(
      `/accounts/${ACCOUNT}/d1/database`,
      'body: JSON.stringify({ name: "db" })'
    )
    expect(received.headers.get('content-type')).toBe('application/json')
    expect(received.text).toBe('{"name":"db"}')
  })

  it.each([
    ['plain text', 'realtime'],
    ['text that happens to be JSON', 'true'],
    ['text that is a number', '42'],
    ['quoted text', '"already quoted"'],
    ['an empty string', '']
  ])('a string is sent as written: %s', async (_, body) => {
    const received = await post(`/accounts/${ACCOUNT}/json`, `body: ${JSON.stringify(body)}`)
    expect(received.text).toBe(body)
    expect(received.headers.get('content-type')).toBe('application/json')
  })

  it('application/scim+json', async () => {
    const received = await post(
      `/accounts/${ACCOUNT}/access/user_populations/p1/users`,
      'headers: { "Content-Type": "application/scim+json" }, body: { userName: "a@example.com" }'
    )
    expect(received.headers.get('content-type')).toBe('application/scim+json')
    expect(received.text).toBe('{"userName":"a@example.com"}')
  })

  it('application/merge-patch+json, where null deletes a key', async () => {
    const received = await send(
      `method: "PATCH", path: "/accounts/${ACCOUNT}/workers/scripts/s/secrets-bulk",
       headers: { "Content-Type": "application/merge-patch+json" }, body: { OLD_SECRET: null }`
    )
    expect(received.headers.get('content-type')).toBe('application/merge-patch+json')
    expect(received.text).toBe('{"OLD_SECRET":null}')
  })

  it.each([
    ['text/plain', `/accounts/${ACCOUNT}/analytics/sql`, 'SELECT 1 AS value'],
    ['text/plain;charset=UTF-8', `/accounts/${ACCOUNT}/one/integrations`, 'name: ✓'],
    [
      'application/x-ndjson',
      `/accounts/${ACCOUNT}/vectorize/v2/indexes/i/insert`,
      '{"id":"a","values":[1]}\n{"id":"b","values":[2]}'
    ],
    ['application/jsonl', `/accounts/${ACCOUNT}/pay-per-use/usage-reports`, '{"id":"a"}\n'],
    ['application/javascript', `/accounts/${ACCOUNT}/workers/scripts/s`, 'export default {}'],
    [
      'text/javascript',
      `/accounts/${ACCOUNT}/workers/dispatch/namespaces/n/scripts/s`,
      'addEventListener("fetch", () => {})'
    ]
  ])('%s: a string, as it is', async (type, path, body) => {
    const received = await send(
      `method: "PUT", path: ${JSON.stringify(path)}, headers: { "Content-Type": ${JSON.stringify(type)} }, body: ${JSON.stringify(body)}`
    )
    expect(received.headers.get('content-type')).toBe(type)
    expect(received.text).toBe(body)
  })

  it('application/octet-stream: bytes', async () => {
    const received = await post(
      `/accounts/${ACCOUNT}/dlp/datasets/d1/upload/1`,
      'headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array([0, 255, 128, 10])'
    )
    expect(received.headers.get('content-type')).toBe('application/octet-stream')
    expect([...received.bytes]).toEqual([0, 255, 128, 10])
  })

  it.each([
    ['a Uint8Array', 'new Uint8Array([0, 255, 128, 10])'],
    ['an ArrayBuffer', 'new Uint8Array([0, 255, 128, 10]).buffer'],
    ['a DataView', 'new DataView(new Uint8Array([0, 255, 128, 10]).buffer)'],
    ['a Blob without a type', 'new Blob([new Uint8Array([0, 255, 128, 10])])']
  ])('%s is sent as it is, with no Content-Type made up', async (_, body) => {
    const received = await send(
      `method: "PUT", path: "/accounts/${ACCOUNT}/storage/kv/namespaces/ns/values/k", body: ${body}`
    )
    expect(received.headers.get('content-type')).toBeNull()
    expect([...received.bytes]).toEqual([0, 255, 128, 10])
  })

  it('a Blob brings its own type, which a Content-Type header replaces', async () => {
    const own = await post(
      `/accounts/${ACCOUNT}/blob`,
      'body: new Blob(["a,b"], { type: "text/csv" })'
    )
    expect(own.headers.get('content-type')).toBe('text/csv')
    expect(own.text).toBe('a,b')

    const replaced = await post(
      `/accounts/${ACCOUNT}/blob`,
      'headers: { "Content-Type": "text/plain" }, body: new Blob(["a,b"], { type: "text/csv" })'
    )
    expect(replaced.headers.get('content-type')).toBe('text/plain')
  })

  it('a stream is sent as it is', async () => {
    const received = await post(
      `/accounts/${ACCOUNT}/stream-body`,
      `headers: { "Content-Type": "application/octet-stream" },
       body: new Blob(["chunk one, ", "chunk two"]).stream()`
    )
    expect(received.headers.get('content-type')).toBe('application/octet-stream')
    expect(received.text).toBe('chunk one, chunk two')
  })

  it('application/x-www-form-urlencoded: URLSearchParams', async () => {
    const received = await post(
      `/accounts/${ACCOUNT}/brand-protection/logos`,
      'body: new URLSearchParams({ tag: "logo", match_type: "image & text" })'
    )
    expect(received.headers.get('content-type')).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8'
    )
    expect(received.text).toBe('tag=logo&match_type=image+%26+text')
  })

  const WORKER_FORM = `(() => {
    const form = new FormData();
    form.append("metadata", new Blob(['{"main_module":"worker.js"}'], { type: "application/json" }));
    form.append("worker.js", new Blob(["export default {}"], { type: "application/javascript+module" }), "worker.js");
    return form;
  })()`

  it.each([
    ['with no Content-Type', ''],
    [
      'with a Content-Type that has no boundary',
      'headers: { "Content-Type": "multipart/form-data" },'
    ],
    [
      'with a Content-Type whose boundary is not the one fetch writes',
      'headers: { "content-type": "multipart/form-data; boundary=made-up" },'
    ]
  ])("multipart/form-data: FormData %s is sent with fetch's boundary", async (_, headers) => {
    const received = await send(
      `method: "PUT", path: "/accounts/${ACCOUNT}/workers/scripts/s", ${headers} body: ${WORKER_FORM}`
    )
    expect(received.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
    expect(received.headers.get('content-type')).not.toContain('made-up')
    const form = await formOf(received)
    expect(await (form.get('metadata') as File).text()).toBe('{"main_module":"worker.js"}')
    const script = form.get('worker.js') as File
    expect(script.name).toBe('worker.js')
    expect(script.type).toBe('application/javascript+module')
    expect(await script.text()).toBe('export default {}')
  })

  it('multipart/form-data: a file part with other headers, as a Worker content upload takes', async () => {
    const received = await send(
      `method: "PUT", path: "/accounts/${ACCOUNT}/workers/scripts/s/content",
       headers: { "CF-WORKER-MAIN-MODULE-PART": "worker.js" }, body: ${WORKER_FORM}`
    )
    expect(received.headers.get('cf-worker-main-module-part')).toBe('worker.js')
    expect((await formOf(received)).has('worker.js')).toBe(true)
  })

  it.each([
    ['undefined', 'undefined'],
    ['null', 'null']
  ])('a %s body sends none', async (_, body) => {
    const received = await send(
      `method: "DELETE", path: "/accounts/${ACCOUNT}/r2/buckets/b", headers: { "cf-r2-jurisdiction": "eu" }, body: ${body}`
    )
    expect(received.bytes).toHaveLength(0)
    expect(received.headers.get('content-type')).toBeNull()
    expect(received.headers.get('cf-r2-jurisdiction')).toBe('eu')
  })
})

describe('execute: options older descriptions documented', () => {
  const PATH = `/accounts/${ACCOUNT}/body`

  it('contentType is the Content-Type header', async () => {
    const received = await send(
      `method: "POST", path: "${PATH}", body: "SELECT 1", contentType: "text/plain"`
    )
    expect(received.headers.get('content-type')).toBe('text/plain')
    expect(received.text).toBe('SELECT 1')
  })

  it('contentType gives way to a Content-Type in headers', async () => {
    const received = await send(
      `method: "POST", path: "${PATH}", body: { a: null }, contentType: "application/json",
       headers: { "Content-Type": "application/merge-patch+json" }`
    )
    expect(received.headers.get('content-type')).toBe('application/merge-patch+json')
  })

  it('contentType: "multipart/form-data" still leaves the boundary to fetch', async () => {
    const received = await send(
      `method: "POST", path: "${PATH}", contentType: "multipart/form-data",
       body: (() => { const form = new FormData(); form.append("a", "1"); return form; })()`
    )
    expect(received.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/)
    expect((await formOf(received)).get('a')).toBe('1')
  })

  it('rawBody sends a string with no Content-Type of ours', async () => {
    const received = await send(
      `method: "POST", path: "${PATH}", body: "plain value", rawBody: true`
    )
    expect(received.headers.get('content-type')).toBe('text/plain;charset=UTF-8')
    expect(received.text).toBe('plain value')
  })
})

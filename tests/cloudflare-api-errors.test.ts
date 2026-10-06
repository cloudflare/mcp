import { describe, expect, it } from 'vitest'
import { boundedApiHint, cloudflareApiErrorSchema, normalizedApiPath, readApiResponse, validDocumentationUrl } from '../src/utils/cloudflare-api-errors'

const DOC = 'https://developers.cloudflare.com/api/resources/workers/methods/list/'
const operation = { method: 'GET', pathTemplate: '/accounts/{account_id}/workers/scripts' }

async function diagnostic(errors: unknown) {
  const parsed = await readApiResponse(Response.json({ success: false, errors }, { status: 200 }), operation)
  if (parsed.kind !== 'api_failure') throw new Error('Expected API failure')
  return parsed.diagnostic
}

describe('safe Cloudflare API diagnostics', () => {
  it.each([
    undefined, 42, 'http://developers.cloudflare.com/api/resources/workers/',
    'https://developers.cloudflare.com.evil/api/resources/workers/',
    'https://evil@developers.cloudflare.com/api/resources/workers/',
    'https://developers.cloudflare.com/api/token',
    `${DOC}?token=secret`, `${DOC}#secret`, `${DOC}?`, `${DOC}#`,
    'https://developers.cloudflare.com/api/resources/../token',
    'https://developers.cloudflare.com:8443/api/resources/workers/',
    `${DOC}${'a'.repeat(512)}`
  ])('ignores unsafe documentation URL %#', async (documentation_url) => {
    const result = await diagnostic([{ code: 10000, message: 'Forbidden', documentation_url }])
    expect(result.errors).toEqual([{ code: 10000, message: 'Forbidden' }])
  })

  it('preserves only valid API-reference links', () => {
    expect(validDocumentationUrl(DOC)).toBe(DOC)
  })

  it('bounds error count, UTF-8 messages, string codes and GraphQL paths exactly', async () => {
    const result = await diagnostic(Array.from({ length: 20 }, () => ({
      code: 'c'.repeat(100), message: 'é'.repeat(1000), path: Array.from({ length: 20 }, () => 'p'.repeat(100)), documentation_url: DOC
    })))
    expect(result.errors.length).toBeLessThanOrEqual(8)
    expect(new TextEncoder().encode(result.errors[0].message)).toHaveLength(512)
    expect(result.errors[0].code).toHaveLength(64)
    expect(result.errors[0].path).toHaveLength(8)
    expect(result.errors[0].path?.[0]).toHaveLength(64)
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(8192)
    expect(cloudflareApiErrorSchema.safeParse(result).success).toBe(true)
  })

  it('bounds a short error list to exactly eight entries', async () => {
    expect((await diagnostic(Array.from({ length: 20 }, () => ({ code: 0, message: 'denied' })))).errors).toHaveLength(8)
  })

  it('never exposes resource identifiers on unmatched routes', () => {
    const template = '/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/{key_name}'
    expect(normalizedApiPath('/accounts/secret/storage/kv/namespaces/private/values/private-key', [template])).toBe(template)
    expect(normalizedApiPath('/accounts/secret/object-names/private-key')).toBe('/accounts/{redacted}')
    expect(normalizedApiPath('/my-secret')).toBe('/{redacted}')
  })

  it('drops arbitrary body fields and response headers', async () => {
    const parsed = await readApiResponse(Response.json({ success: false, errors: [], body: 'private', token: 'secret' }, {
      status: 403, headers: { 'CF-Ray': 'ray-SJC', 'Set-Cookie': 'secret', 'Retry-After': '30', 'WWW-Authenticate': 'Bearer secret' }
    }), operation)
    expect(parsed).toMatchObject({ kind: 'api_failure', diagnostic: { requestId: 'ray-SJC', retryAfterSeconds: 30 } })
    expect(JSON.stringify(parsed)).not.toMatch(/private|secret|Cookie|WWW-Authenticate/)
  })

  it('bounds and redacts account guidance without hiding the API failure', () => {
    const hint = boundedApiHint('Unknown account secret-token https://example.com/oauth?private=secret ' + 'x'.repeat(40000), 'secret-token')
    expect(new TextEncoder().encode(hint).length).toBeLessThanOrEqual(512)
    expect(hint).not.toMatch(/secret-token|private=secret|https:\/\//)
  })

  it('bounds mandatory metadata even with no error detail', async () => {
    const parsed = await readApiResponse(Response.json({ success: false }, { status: 403 }), {
      method: 'X'.repeat(40000), pathTemplate: '/'.repeat(40000)
    })
    if (parsed.kind !== 'api_failure') throw new Error('Expected failure')
    expect(parsed.diagnostic.operation.method).toBe('UNKNOWN')
    expect(parsed.diagnostic.operation.pathTemplate).toHaveLength(256)
    expect(cloudflareApiErrorSchema.safeParse(parsed.diagnostic).success).toBe(true)
  })

  it('bounds the JSON object even when escaped messages inflate its encoded size', async () => {
    const result = await diagnostic(Array.from({ length: 8 }, () => ({ code: 1, message: '"'.repeat(512), path: Array.from({ length: 8 }, () => '"'.repeat(64)), documentation_url: DOC })))
    expect(result.errors.length).toBeLessThan(8)
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(8192)
    expect(result.operation).toEqual(operation)
  })
})

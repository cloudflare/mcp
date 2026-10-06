import { env } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleAuthenticatedMcpRequest } from '../src/mcp-handler'
import * as cache from '../src/isolate-cache'
import { deriveOperationPolicies } from '../src/auth/operation-scopes'
import { mcpToolCallRequest, modernMcpRequest, parseMcpResult, MCP_URL } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'

const paths = { '/zones/{zone_id}/dns_records': { post: { 'x-api-token-group': ['DNS Write'], requestBody: { content: { 'application/json': {} } } } } }
const policy = { ...deriveOperationPolicies(paths)[0], state: 'reviewed' as const, review: { source: 'test OAuth contract', version: 'test' } }
const props = { type: 'user_token', accessToken: 'upstream-test-token', user: { id: 'user', email: 'user@example.com' }, accounts: [] }
const auth = { token: 'mcp-test-token', audience: MCP_URL, userId: 'user', clientId: 'client', scope: ['user:read', 'account:read'] }
let forwarded = 0

beforeEach(async () => {
  forwarded = 0
  await seedSpec(paths)
  vi.spyOn(cache, 'getOperationPolicies').mockResolvedValue([policy])
  server.use(http.post('https://api.cloudflare.com/client/v4/zones/zone/dns_records', () => {
    forwarded++
    return HttpResponse.json({ success: true, result: { id: 'new-record' } })
  }))
})
afterEach(async () => { vi.restoreAllMocks(); await clearSpec() })

function request(modern: boolean, compatibility = false) {
  const url = `${MCP_URL}?codemode=false${compatibility ? '&oauthChallenge=tool' : ''}`
  if (modern) return modernMcpRequest(auth.token, 'tools/call', { name: 'post_zones_dns_records', arguments: { zone_id: 'zone', body: '{}' } }, { url, origin: 'https://mcp.cloudflare.com' })
  const original = mcpToolCallRequest(auth.token, 'post_zones_dns_records', { zone_id: 'zone', body: '{}' })
  const headers = new Headers(original.headers)
  headers.set('Origin', 'https://mcp.cloudflare.com')
  return new Request(url, { method: 'POST', headers, body: original.body })
}

describe('permission challenge HTTP boundary', () => {
  it.each([true, false])('denies reviewed missing OAuth scopes before dispatch (modern=%s)', async (modern) => {
    const response = await handleAuthenticatedMcpRequest(request(modern), props, auth)
    expect(response.status).toBe(403)
    expect(forwarded).toBe(0)
    expect(response.headers.get('WWW-Authenticate')).toContain('error="insufficient_scope"')
    expect(response.headers.get('WWW-Authenticate')).toContain('scope="dns.write"')
    expect(response.headers.get('WWW-Authenticate')).toContain('/.well-known/oauth-protected-resource/mcp')
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('WWW-Authenticate')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://mcp.cloudflare.com')
  })
  it.each([true, false])('provides the separate SDK tool compatibility metadata (modern=%s)', async (modern) => {
    const response = await handleAuthenticatedMcpRequest(request(modern, true), props, auth)
    expect(response.status).toBe(200)
    const result = await parseMcpResult(response)
    expect(result.result?.isError).toBe(true)
    expect(result.result?._meta?.['mcp/www_authenticate']).toEqual([expect.stringContaining('scope="dns.write"')])
    expect(forwarded).toBe(0)
  })
  it('advertises supported bootstrap OAuth metadata without a token-specific requirement', async () => {
    const response = await handleAuthenticatedMcpRequest(modernMcpRequest(auth.token, 'tools/list', {}, { url: `${MCP_URL}?codemode=false` }), props, auth)
    const body = await response.json() as { result: { tools: Array<{ name: string; _meta?: unknown }> } }
    expect(body.result.tools.find((tool) => tool.name === 'post_zones_dns_records')?._meta).toEqual({ securitySchemes: [{ type: 'oauth2', scopes: ['user:read', 'account:read'] }] })
  })
  it('preserves direct credentials as unknown rather than demanding an OAuth upgrade', async () => {
    const response = await handleAuthenticatedMcpRequest(request(true), props, { token: 'direct', audience: MCP_URL, scope: [] })
    expect(response.status).toBe(200)
    expect(forwarded).toBe(1)
    expect(response.headers.get('WWW-Authenticate')).toBeNull()
  })
  it('keeps a mismatched canonical resource scope context unknown', async () => {
    const response = await handleAuthenticatedMcpRequest(request(true), props, { ...auth, audience: 'https://other.example.com/mcp' })
    expect(response.status).toBe(200)
    expect(forwarded).toBe(1)
    expect(response.headers.get('WWW-Authenticate')).toBeNull()
  })
  it('allows a sufficient verified grant and does not assume write implies read', async () => {
    const response = await handleAuthenticatedMcpRequest(request(true), props, { ...auth, scope: ['dns.write'] })
    expect(response.status).toBe(200)
    expect(forwarded).toBe(1)
  })
  it('keeps unknown policy and account/resource denials out of the auth signal', async () => {
    vi.spyOn(cache, 'getOperationPolicies').mockResolvedValue([{ ...policy, state: 'candidate' }])
    server.use(http.post('https://api.cloudflare.com/client/v4/zones/zone/dns_records', () => HttpResponse.json({ success: false, errors: [{ code: 10000, message: 'Account access denied' }] }, { status: 403 })))
    const response = await handleAuthenticatedMcpRequest(request(true), props, auth)
    expect(response.status).toBe(200)
    const result = await parseMcpResult(response)
    expect(result.result?.isError).toBe(true)
    expect(result.result?._meta?.['mcp/www_authenticate']).toBeUndefined()
  })
  it('treats corrupt or absent optional artifacts as unknown', async () => {
    vi.restoreAllMocks()
    await env.SPEC_BUCKET.put('operation-scopes.json', 'invalid-json')
    cache.resetIsolateCache()
    expect(await cache.getOperationPolicies()).toEqual([])
    const response = await handleAuthenticatedMcpRequest(request(true), props, auth)
    expect(response.status).toBe(200)
    expect(forwarded).toBe(1)
  })
})

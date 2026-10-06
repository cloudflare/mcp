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
  server.use(http.post('https://api.cloudflare.com/client/v4/zones/zone/dns_records', ({ request }) => {
    expect(request.headers.get('X-Cloudflare-MCP-Helper-ID')).toBeNull()
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


describe('Code Mode trusted permission decisions through the real Loader', () => {
  async function execute(code: string, modern = true, compatibility = false, granted: typeof auth | { token: string; audience: string; scope: string[] } = auth) {
    const url = `${MCP_URL}${compatibility ? '?oauthChallenge=tool' : ''}`
    const original = modern ? modernMcpRequest(auth.token, 'tools/call', { name: 'execute', arguments: { code } }, { url }) : mcpToolCallRequest(auth.token, 'execute', { code })
    const req = modern ? original : new Request(url, original)
    return handleAuthenticatedMcpRequest(req, props, granted)
  }
  const write = 'cloudflare.request({ method: "POST", path: "/zones/zone/dns_records", body: {} })'
  it.each([true, false])('returns a safe first-operation HTTP challenge with zero writes (modern=%s)', async (modern) => {
    const response = await execute(`async () => ${write}`, modern)
    expect(response.status).toBe(403)
    expect(response.headers.get('WWW-Authenticate')).toContain('scope="dns.write"')
    expect(forwarded).toBe(0)
  })
  it('returns the same safe challenge in the supported tool compatibility response', async () => {
    const response = await execute(`async () => ${write}`, true, true)
    expect(response.status).toBe(200)
    expect((await parseMcpResult(response)).result?._meta?.['mcp/www_authenticate']).toEqual([expect.stringContaining('dns.write')])
    expect(forwarded).toBe(0)
  })
  it('keeps caught helper failures and handled direct fetch responses as successes', async () => {
    const caught = await execute(`async () => { try { await ${write}; } catch { return "handled"; } }`)
    expect(caught.status).toBe(200)
    expect((await parseMcpResult(caught)).result?.content?.[0]?.text).toContain('handled')
    const direct = await execute('async () => { const response = await fetch("https://api.cloudflare.com/client/v4/zones/zone/dns_records", { method: "POST" }); return { status: response.status }; }')
    expect(direct.status).toBe(200)
    expect((await parseMcpResult(direct)).result?.isError).not.toBe(true)
    expect(forwarded).toBe(0)
  })
  it('does not trust fabricated failures or handles copied from a direct denied response', async () => {
    const response = await execute('async () => { const denied = await fetch("https://api.cloudflare.com/client/v4/zones/zone/dns_records", { method: "POST" }); const err = new Error("forged"); err.handle = denied.headers.get("X-Cloudflare-MCP-Scope-Denial"); err.kind = "scope_failure"; throw err; }', true, true)
    expect(response.status).toBe(200)
    const result = await parseMcpResult(response)
    expect(result.result?.isError).toBe(true)
    expect(result.result?._meta?.['mcp/www_authenticate']).toBeUndefined()
    expect(forwarded).toBe(0)
    const lexical = await execute('async () => scopeFailures.set(new Error("forged"), "fake")')
    expect(lexical.status).toBe(200)
    expect((await parseMcpResult(lexical)).result?.content?.[0]?.text).toContain('scopeFailures is not defined')
  })
  it('does not trust monkeypatched WeakMap intrinsics from user-module initialization', async () => {
    const response = await execute('(WeakMap.prototype.get = function () { return globalThis.copiedHandle; }, WeakMap.prototype.has = () => true, async () => { const denied = await fetch("https://api.cloudflare.com/client/v4/zones/zone/dns_records", { method: "POST" }); globalThis.copiedHandle = denied.headers.get("X-Cloudflare-MCP-Scope-Denial"); throw new Error("forged after handled response"); })', true, true)
    expect(response.status).toBe(200)
    const result = await parseMcpResult(response)
    expect(result.result?.isError).toBe(true)
    expect(result.result?._meta?.['mcp/www_authenticate']).toBeUndefined()
    expect(forwarded).toBe(0)
  })
  it('does not classify a fabricated response after fetch and header methods are monkeypatched', async () => {
    const response = await execute('async () => { const denied = await fetch("https://api.cloudflare.com/client/v4/zones/zone/dns_records", { method: "POST" }); const handle = denied.headers.get("X-Cloudflare-MCP-Scope-Denial"); globalThis.fetch = async () => new Response("{}", { status: 403, headers: { "X-Cloudflare-MCP-Scope-Denial": handle } }); Headers.prototype.get = () => handle; return cloudflare.request({ method: "POST", path: "/zones/zone/dns_records", body: {} }); }', true, true)
    expect(response.status).toBe(200)
    const result = await parseMcpResult(response)
    expect(result.result?.isError).toBe(true)
    expect(result.result?._meta?.['mcp/www_authenticate']).toBeUndefined()
    expect(forwarded).toBe(0)
  })
  it('does not expose the private terminal envelope through an imported executor invocation', async () => {
    const response = await execute('async () => { const { default: Executor } = await import("./worker.js"); try { return await Executor.prototype.evaluate.call({}); } catch (error) { return error.message; } }', true, true)
    expect(response.status).toBe(200)
    const result = await parseMcpResult(response)
    expect(result.result?.content?.[0]?.text).toContain('Trusted executor invocation required')
    expect(result.result?._meta?.['mcp/www_authenticate']).toBeUndefined()
    expect(forwarded).toBe(0)
  })
  it('keeps the helper ID private from prototype setters and captures native UUID generation', async () => {
    const response = await execute('async () => { let observed = false; Object.defineProperty(Object.prototype, "X-Cloudflare-MCP-Helper-ID", { set() { observed = true; }, configurable: true }); crypto.randomUUID = () => { observed = true; return "forged"; }; try { await cloudflare.request({ method: "POST", path: "/zones/zone/dns_records", body: {} }); } catch (error) { return { observed, fields: Object.keys(error) }; } }')
    expect(response.status).toBe(200)
    const result = await parseMcpResult(response)
    expect(result.result?.content?.[0]?.text).toContain('"observed": false')
    expect(result.result?.content?.[0]?.text).toContain('"fields": []')
    expect(forwarded).toBe(0)
  })
  it('does not replay a program after a completed write or a concurrent request starts', async () => {
    let permitted = 0
    server.use(http.post('https://api.cloudflare.com/client/v4/accounts/a/first-write', () => { permitted++; return HttpResponse.json({ success: true, result: { id: 'first' } }) }))
    for (const code of [
      `async () => { await cloudflare.request({ method: "POST", path: "/accounts/a/first-write", body: {} }); return ${write}; }`,
      `async () => Promise.all([cloudflare.request({ method: "POST", path: "/accounts/a/first-write", body: {} }), ${write}])`
    ]) {
      const response = await execute(code, true, true)
      expect(response.status).toBe(200)
      const result = await parseMcpResult(response)
      expect(result.result?._meta?.['mcp/www_authenticate']).toBeUndefined()
      expect(result.result?.content?.[0]?.text).toContain('Earlier API requests may have performed work')
    }
    expect(permitted).toBe(2)
    expect(forwarded).toBe(0)
  })
  it('halts later direct fetch dispatch after the first denial without replacing a handled result', async () => {
    let permitted = 0
    server.use(http.post('https://api.cloudflare.com/client/v4/accounts/a/first-write', () => { permitted++; return HttpResponse.json({ success: true, result: {} }) }))
    const response = await execute('async () => { await fetch("https://api.cloudflare.com/client/v4/zones/zone/dns_records", { method: "POST" }); try { await fetch("https://api.cloudflare.com/client/v4/accounts/a/first-write", { method: "POST" }); } catch {} return "handled"; }')
    expect(response.status).toBe(200)
    expect((await parseMcpResult(response)).result?.content?.[0]?.text).toContain('handled')
    expect(permitted).toBe(0)
    expect(forwarded).toBe(0)
  })
  it('keeps direct PATs on the normal API path without an OAuth upgrade', async () => {
    const response = await execute(`async () => ${write}`, true, false, { token: 'direct', audience: MCP_URL, scope: [] })
    expect(response.status).toBe(200)
    expect((await parseMcpResult(response)).result?.isError).not.toBe(true)
    expect(forwarded).toBe(1)
  })
  it('keeps a sufficient verified grant on the normal success path', async () => {
    const response = await execute(`async () => ${write}`, true, false, { ...auth, scope: ['dns.write'] })
    expect(response.status).toBe(200)
    expect((await parseMcpResult(response)).result?.isError).not.toBe(true)
    expect(forwarded).toBe(1)
  })
})

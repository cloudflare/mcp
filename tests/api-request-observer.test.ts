import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createApiRequestObserver } from '../src/utils/api-request-observer'
import { server } from './setup/msw'
import { http, HttpResponse } from 'msw'
import { API_BASE, cfSuccess } from './helpers/cloudflare-api'
import { deriveOperationPolicies } from '../src/auth/operation-scopes'

// Real Loader and a service binding inside GlobalOutbound props; only API fetch is mocked.
describe('request-local trusted outbound observer', () => {
  it('records actual concurrent dispatches through the service capability in props', async () => {
    const { observer, nonce } = await createApiRequestObserver()
    const outbound = exports.GlobalOutbound({ props: {
      apiToken: 'observer-test-token', fetchWithRetryCaller: 'test',
      pathTemplates: ['/user', '/accounts/{account_id}/workers/scripts'], observer, observerNonce: nonce
    } })
    server.use(http.get(`${API_BASE}/user`, () => HttpResponse.json(cfSuccess({ id: 'u' }))),
      http.get(`${API_BASE}/accounts/private-account/workers/scripts`, () => HttpResponse.json({ success: false }, { status: 403 })))
    const responses = await Promise.all([
      outbound.fetch(`${API_BASE}/user`),
      outbound.fetch(`${API_BASE}/accounts/private-account/workers/scripts`)
    ])
    await Promise.all(responses.map((response) => response.body?.cancel()))
    const snapshot = await observer.snapshot(nonce)
    expect(snapshot?.overflow).toBe(false)
    expect(snapshot?.dispatches.map(({ sequence }) => sequence)).toEqual([0, 1])
    // Concurrent service calls can reach the observer in either order.
    expect(snapshot?.dispatches).toEqual(expect.arrayContaining([
      { sequence: expect.any(Number), method: 'GET', pathTemplate: '/user', status: 200 },
      { sequence: expect.any(Number), method: 'GET', pathTemplate: '/accounts/{account_id}/workers/scripts', status: 403 }
    ]))
    const separate = await createApiRequestObserver()
    expect(await separate.observer.snapshot(separate.nonce)).toMatchObject({ dispatches: [], overflow: false })
    expect(await observer.snapshot(separate.nonce)).toBeNull()
    expect(await observer.initialize(nonce)).toBe(false)
  })

  it('fails closed when the trusted isolate has no initialization state', async () => {
    const observer = exports.ApiRequestObserverEntrypoint({ props: { workerId: `uninitialized-${crypto.randomUUID()}` } })
    const nonce = crypto.randomUUID()
    expect(await observer.snapshot(nonce)).toBeNull()
    expect(await observer.beginDispatch(nonce, 'GET', '/user')).toBeNull()
    expect(await observer.finishDispatch(nonce, 0, 200)).toBe(false)
  })

  it('records in-flight dispatches, bounds history, and reports overflow explicitly', async () => {
    const { observer, nonce } = await createApiRequestObserver()
    expect(await observer.beginDispatch(nonce, 'X'.repeat(40000), '/user')).toBeNull()
    expect(await observer.beginDispatch(nonce, 'GET', 'é'.repeat(200))).toBeNull()
    const sequences = await Promise.all(Array.from({ length: 65 }, () => observer.beginDispatch(nonce, 'POST', '/graphql')))
    expect(sequences.filter((sequence): sequence is number => typeof sequence === 'number').sort((a, b) => a - b)).toEqual(Array.from({ length: 65 }, (_, index) => index))
    const snapshot = await observer.snapshot(nonce)
    expect(snapshot?.overflow).toBe(true)
    expect(snapshot?.dispatches).toHaveLength(64)
    expect(snapshot?.dispatches[0]).not.toHaveProperty('status')
  })
})


describe('permission observer reset safety', () => {
  it('halts a reset/uninitialized capability before forwarding and retains earlier dispatch evidence', async () => {
    const original = await createApiRequestObserver()
    const sequence = await original.observer.beginDispatch(original.nonce, 'POST', '/accounts/{account_id}/first-write')
    expect(sequence).toBe(0)
    const reset = exports.ApiRequestObserverEntrypoint({ props: { workerId: `reset-${crypto.randomUUID()}` } })
    let forwarded = 0
    server.use(http.get(`${API_BASE}/user`, () => { forwarded++; return HttpResponse.json(cfSuccess({})) }))
    const outbound = exports.GlobalOutbound({ props: { apiToken: 'reset-test', fetchWithRetryCaller: 'test', pathTemplates: ['/user'], observer: reset, observerNonce: original.nonce } })
    await expect(outbound.fetch(`${API_BASE}/user`)).rejects.toThrow()
    expect(forwarded).toBe(0)
    const denial = await original.observer.beginDispatch(original.nonce, 'POST', '/zones/{zone_id}/dns_records', ['dns.write'])
    expect(denial).toMatchObject({ safe: false, scopes: ['dns.write'] })
    expect(await original.observer.snapshot(original.nonce)).toMatchObject({ dispatches: [{ sequence: 0 }], inFlight: 1 })
  })
  it('omits arbitrary direct-fetch helper markers from bounded trusted denial history', async () => {
    const { observer, nonce } = await createApiRequestObserver()
    const policy = { ...deriveOperationPolicies({ '/zones/{zone_id}/dns_records': { post: { 'x-api-token-group': ['DNS Write'] } } })[0], state: 'reviewed' as const, review: { source: 'test', version: 'test' } }
    const outbound = exports.GlobalOutbound({ props: { apiToken: 'test', fetchWithRetryCaller: 'test', pathTemplates: [policy.path], observer, observerNonce: nonce, scopeContext: { audience: 'https://mcp.cloudflare.com/mcp', userId: 'u', clientId: 'c', scope: [] }, operationPolicies: [policy] } })
    const response = await outbound.fetch(`${API_BASE}/zones/zone/dns_records`, { method: 'POST', headers: { 'X-Cloudflare-MCP-Helper-ID': 'x'.repeat(1000) } })
    expect(response.status).toBe(403)
    await response.body?.cancel()
    expect((await observer.snapshot(nonce))?.denial?.helperId).toBeUndefined()
  })
  it('atomically stops all later dispatch after a safe denial and reports incomplete observation', async () => {
    const { observer, nonce } = await createApiRequestObserver()
    const denial = await observer.beginDispatch(nonce, 'POST', '/zones/{zone_id}/dns_records', ['dns.write'])
    expect(denial).toMatchObject({ safe: true })
    expect(await observer.beginDispatch(nonce, 'POST', '/accounts/{account_id}/first-write')).toBeNull()
    expect(await observer.finishDispatch(nonce, 999, 200)).toBe(false)
    expect(await observer.snapshot(nonce)).toMatchObject({ dispatches: [], complete: false })
  })
})

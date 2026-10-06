import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createApiRequestObserver } from '../src/utils/api-request-observer'
import { server } from './setup/msw'
import { http, HttpResponse } from 'msw'
import { API_BASE, cfSuccess } from './helpers/cloudflare-api'

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
    expect(await observer.snapshot(nonce)).toEqual({ overflow: false, dispatches: [
      { sequence: 0, method: 'GET', pathTemplate: '/user', status: 200 },
      { sequence: 1, method: 'GET', pathTemplate: '/accounts/{account_id}/workers/scripts', status: 403 }
    ] })
    const separate = await createApiRequestObserver()
    expect(await separate.observer.snapshot(separate.nonce)).toEqual({ dispatches: [], overflow: false })
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
    expect(sequences.sort((a, b) => (a ?? -1) - (b ?? -1))).toEqual(Array.from({ length: 65 }, (_, index) => index))
    const snapshot = await observer.snapshot(nonce)
    expect(snapshot?.overflow).toBe(true)
    expect(snapshot?.dispatches).toHaveLength(64)
    expect(snapshot?.dispatches[0]).not.toHaveProperty('status')
  })
})

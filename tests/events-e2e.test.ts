import { env, exports } from 'cloudflare:workers'
import { getOAuthApi } from '@cloudflare/workers-oauth-provider'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOMATIONS, POLICIES, WEBHOOKS } from '../src/events/api'
import { USER_AGENT } from '../src/constants'
import { API_BASE, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { modernMcpRequest } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'

const accountId = 'a'.repeat(32)
const token = 'cfat_events-local-test-token'
const callbackUrl = 'https://receiver.example.com/events'
const signingSecret = `whsec_${btoa('a'.repeat(32))}`
const params = {
  name: 'cloudflare.alert.workers_observability_real_time_issue',
  arguments: { account_id: accountId, service: 'checkout', afterOccurrences: 1 },
  delivery: { mode: 'webhook', url: callbackUrl, secret: signingSecret }
}

interface Resource {
  id: string
  name: string
  [key: string]: unknown
}
interface RpcResponse {
  result?: {
    id?: string
    refreshBefore?: string
    capabilities?: { events?: object }
    events?: unknown[]
  }
  error?: { code: number }
}
const resources = new Map<string, Map<string, Resource>>()
const requests: Array<{ method: string; path: string }> = []
const deliveries: Array<{ body: string; headers: Headers }> = []
let callbackStatus = 204
let rejectVerification = false
let failNext = ''
let policyReadStatus = 200
let verificationCount = 0
let bootstrapCount = 0
let validKeys = [signingSecret]

function records(path: string) {
  return resources.get(path)!
}

async function rpc(
  method: string,
  input: Record<string, unknown> = {},
  bearer = token
): Promise<RpcResponse> {
  const response = await exports.default.fetch(modernMcpRequest(bearer, method, input))
  const text = await response.text()
  const body =
    text.startsWith('event:') || text.startsWith('data:')
      ? text
          .split('\n')
          .find((line) => line.startsWith('data:'))!
          .slice(5)
      : text
  return JSON.parse(body)
}

async function checkSignature(request: { headers: Headers }, body: string) {
  const signatures = request.headers.get('webhook-signature')!.split(' ')
  const signed = `${request.headers.get('webhook-id')}.${request.headers.get('webhook-timestamp')}.${body}`
  for (const secret of validKeys) {
    const key = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(atob(secret.slice(6)), (character) => character.charCodeAt(0)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed))
    if (signatures.includes(`v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`)) return
  }
  throw new Error('Receiver rejected webhook signature')
}

function ansRequest(destination = [...records(WEBHOOKS).values()][0], overrides = {}) {
  const policy = [...records(POLICIES).values()][0]
  return new Request(destination.url as string, {
    method: 'POST',
    headers: { 'cf-webhook-auth': destination.secret as string },
    body: JSON.stringify({
      name: destination.name,
      text: 'Checkout issue',
      account_id: accountId,
      policy_id: policy?.id ?? 'deleted',
      alert_type: 'workers_observability_real_time_issue',
      alert_correlation_id: 'vega-persisted-run-1',
      ts: 1_800_000_000,
      data: {
        issue: { id: 'issue-1', services: [{ name: 'checkout' }], title: 'Unhandled exception' }
      },
      ...overrides
    })
  })
}

beforeEach(async () => {
  resources.clear()
  for (const path of [WEBHOOKS, POLICIES, AUTOMATIONS]) resources.set(path, new Map())
  requests.length = 0
  deliveries.length = 0
  callbackStatus = 204
  rejectVerification = false
  failNext = ''
  policyReadStatus = 200
  verificationCount = 0
  bootstrapCount = 0
  validKeys = [signingSecret]
  await seedSpec({})
  mockIdentityProbe({ accounts: [{ id: accountId, name: 'Events test' }] })
  server.use(
    http.get(`${API_BASE}/accounts/${accountId}/alerting/v3/available_alerts`, () =>
      HttpResponse.json(
        cfSuccess({
          Workers: [
            {
              type: 'workers_observability_real_time_issue',
              display_name: 'Worker issue',
              description: 'An issue automation fires',
              filter_options: []
            }
          ]
        })
      )
    ),
    http.post(callbackUrl, async ({ request }) => {
      const body = await request.text()
      await checkSignature(request, body)
      const value = JSON.parse(body)
      if (value.type === 'verification') {
        verificationCount++
        return HttpResponse.json({ challenge: rejectVerification ? 'wrong' : value.challenge })
      }
      expect(request.headers.get('webhook-id')).toBe(value.eventId)
      deliveries.push({ body, headers: request.headers })
      return new HttpResponse(null, { status: callbackStatus })
    }),
    http.all(`${API_BASE}/accounts/${accountId}/*`, async ({ request }) => {
      expect(request.headers.get('Authorization')).toBe(`Bearer ${token}`)
      expect(request.headers.get('User-Agent')).toBe(USER_AGENT)
      const path = new URL(request.url).pathname.slice(`/client/v4/accounts/${accountId}`.length)
      const collection = [WEBHOOKS, POLICIES, AUTOMATIONS].find(
        (prefix) => path === prefix || path.startsWith(prefix + '/')
      )
      if (!collection) throw new Error(`Unexpected API path ${path}`)
      const records = resources.get(collection)!
      const resourceId = path === collection ? undefined : path.slice(collection.length + 1)
      requests.push({ method: request.method, path })
      if (failNext === `${request.method} ${collection}`) {
        failNext = ''
        return HttpResponse.json({ success: false, errors: [] }, { status: 503 })
      }
      if (
        resourceId &&
        collection === POLICIES &&
        request.method === 'GET' &&
        policyReadStatus !== 200
      )
        return new HttpResponse(null, { status: policyReadStatus })
      if (request.method === 'GET') {
        if (resourceId && !records.has(resourceId)) return new HttpResponse(null, { status: 404 })
        const value = resourceId ? records.get(resourceId) : [...records.values()]
        return HttpResponse.json(
          cfSuccess(
            collection === AUTOMATIONS
              ? { [resourceId ? 'automation' : 'automations']: value }
              : value
          )
        )
      }
      if (request.method === 'DELETE') {
        records.delete(resourceId!)
        return HttpResponse.json(cfSuccess({ id: resourceId }))
      }
      const input = (await request.json()) as Record<string, unknown>
      if (collection === WEBHOOKS && request.method === 'POST') {
        const probe = await exports.default.fetch(
          new Request(input.url as string, {
            method: 'POST',
            headers: { 'cf-webhook-auth': input.secret as string },
            body: JSON.stringify({
              text: 'Hello World! This is a test message sent from https://cloudflare.com.'
            })
          })
        )
        expect(probe.status).toBe(204)
        bootstrapCount++
      }
      const id = resourceId ?? crypto.randomUUID().replaceAll('-', '')
      const value = { ...input, id } as Resource
      records.set(id, value)
      return HttpResponse.json(
        cfSuccess(collection === AUTOMATIONS ? { automation: value } : { id })
      )
    })
  )
})

afterEach(async () => {
  vi.restoreAllMocks()
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

describe('MCP Events through the real Worker', () => {
  it('uses provider-issued credentials and stops when their grant is revoked', async () => {
    const redirectUri = 'https://app.example.com/cb'
    const registration = await exports.default.fetch(
      new Request('https://mcp.cloudflare.com/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' })
      })
    )
    expect(registration.status).toBe(201)
    const client = (await registration.json()) as { client_id: string }
    const verifier = 'x'.repeat(43)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
    const helpers = getOAuthApi(
      {
        apiHandlers: { '/mcp': { fetch: () => new Response(null, { status: 404 }) } },
        defaultHandler: { fetch: () => new Response(null, { status: 404 }) },
        authorizeEndpoint: '/authorize',
        tokenEndpoint: '/token',
        resourceMetadata: { resource: env.MCP_RESOURCE }
      },
      env
    )
    const authorize = new URL('https://mcp.cloudflare.com/authorize')
    authorize.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'user:read account:read',
      resource: env.MCP_RESOURCE,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString()
    const request = await helpers.parseAuthRequest(new Request(authorize))
    const approved = await helpers.completeAuthorization({
      request,
      userId: 'events-user',
      scope: request.scope,
      metadata: {},
      props: {
        type: 'account_token',
        accessToken: token,
        account: { id: accountId, name: 'Events test' }
      }
    })
    const exchange = await exports.default.fetch(
      new Request('https://mcp.cloudflare.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: new URL(approved.redirectTo).searchParams.get('code')!,
          client_id: client.client_id,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          resource: env.MCP_RESOURCE
        }).toString()
      })
    )
    expect(exchange.status).toBe(200)
    const issued = (await exchange.json()) as { access_token: string }
    expect((await rpc('events/subscribe', params, issued.access_token)).error).toBeUndefined()
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(deliveries).toHaveLength(1)
    const summary = await helpers.unwrapToken(issued.access_token)
    await helpers.revokeGrant(summary!.grantId, summary!.userId)
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(deliveries).toHaveLength(1)
  })
  it('advertises a catalogue of event types without creating resources', async () => {
    expect((await rpc('server/discover')).result?.capabilities?.events).toEqual({})
    const list = await rpc('events/list')
    expect(list.result?.events).toHaveLength(1)
    expect(requests.every((request) => request.method === 'GET')).toBe(true)
  })

  it('subscribes, provisions real API shapes, delivers a signed event and unsubscribes', async () => {
    const subscribed = await rpc('events/subscribe', params)
    expect(subscribed.error).toBeUndefined()
    expect(subscribed.result?.id).toMatch(/^sub_[a-f0-9]{64}$/)
    expect(bootstrapCount).toBe(1)
    expect(verificationCount).toBe(1)
    const policy = [...records(POLICIES).values()][0]
    expect(policy.enabled).toBe(true)
    expect(JSON.stringify(policy)).not.toContain(signingSecret)
    expect(JSON.stringify(policy)).not.toContain(token)
    expect([...records(AUTOMATIONS).values()][0]).toMatchObject({
      service: 'checkout',
      afterOccurrences: 1,
      policyId: policy.id,
      enabled: true
    })
    const request = ansRequest()
    expect((await exports.default.fetch(request.clone())).status).toBe(204)
    expect(deliveries).toHaveLength(1)
    expect(JSON.parse(deliveries[0].body)).toMatchObject({
      name: params.name,
      data: { data: { issue: { id: 'issue-1' } } },
      cursor: null
    })
    const { secret: _secret, ...delivery } = params.delivery
    expect((await rpc('events/unsubscribe', { ...params, delivery })).error).toBeUndefined()
    expect((await rpc('events/unsubscribe', { ...params, delivery })).error).toBeUndefined()
    expect([...resources.values()].every((collection) => collection.size === 0)).toBe(true)
    expect((await exports.default.fetch(request.clone())).status).toBe(204)
    expect(deliveries).toHaveLength(1)
  })

  it('refreshes without duplicates and verifies a replacement signing key', async () => {
    const first = await rpc('events/subscribe', params)
    expect((await rpc('events/subscribe', params)).result?.id).toBe(first.result?.id)
    expect(verificationCount).toBe(1)
    const replacement = `whsec_${btoa('b'.repeat(32))}`
    validKeys = [replacement]
    expect(
      (
        await rpc('events/subscribe', {
          ...params,
          delivery: { ...params.delivery, secret: replacement }
        })
      ).result?.id
    ).toBe(first.result?.id)
    expect(verificationCount).toBe(2)
    expect([...resources.values()].every((collection) => collection.size === 1)).toBe(true)
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(deliveries[0].headers.get('webhook-signature')?.split(' ')).toHaveLength(2)
  })

  it('returns transient failures to ANS and preserves event identity on redelivery', async () => {
    await rpc('events/subscribe', params)
    callbackStatus = 429
    expect((await exports.default.fetch(ansRequest())).status).toBe(503)
    expect(deliveries).toHaveLength(1)
    callbackStatus = 204
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(deliveries).toHaveLength(2)
    expect(deliveries[1].body).toBe(deliveries[0].body)
  })

  it('rejects failed verification before creating ANS resources', async () => {
    rejectVerification = true
    expect((await rpc('events/subscribe', params)).error?.code).toBe(-32015)
    expect([...resources.values()].every((collection) => collection.size === 0)).toBe(true)
  })

  it('recovers partial provisioning on the next subscribe', async () => {
    failNext = `POST ${AUTOMATIONS}`
    expect((await rpc('events/subscribe', params)).error).toBeDefined()
    expect([...records(POLICIES).values()][0].enabled).toBe(false)
    expect((await rpc('events/subscribe', params)).error).toBeUndefined()
    expect([...resources.values()].every((collection) => collection.size === 1)).toBe(true)
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
  })

  it('stops after expiry without a background scheduler', async () => {
    const result = await rpc('events/subscribe', params)
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(result.result!.refreshBefore!) + 1)
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(deliveries).toHaveLength(0)
  })

  it('disables the authoritative policy after callback 410', async () => {
    await rpc('events/subscribe', params)
    callbackStatus = 410
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect([...records(POLICIES).values()][0].enabled).toBe(false)
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(deliveries).toHaveLength(1)
  })

  it('honors live permission revocation and leaves transient API failures to ANS', async () => {
    await rpc('events/subscribe', params)
    policyReadStatus = 503
    expect((await exports.default.fetch(ansRequest())).status).toBe(503)
    policyReadStatus = 403
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(deliveries).toHaveLength(0)
  })

  it('leaves rate-limited delivery authorization checks to ANS without local retries', async () => {
    await rpc('events/subscribe', params)
    requests.length = 0
    policyReadStatus = 429
    expect((await exports.default.fetch(ansRequest())).status).toBe(503)
    expect(
      requests.filter(
        (request) => request.method === 'GET' && request.path.startsWith(POLICIES + '/')
      )
    ).toHaveLength(1)
    expect(deliveries).toHaveLength(0)
  })

  it('rejects another account and forged ingress credentials', async () => {
    expect(
      (
        await rpc('events/subscribe', {
          ...params,
          arguments: { ...params.arguments, account_id: 'b'.repeat(32) }
        })
      ).error
    ).toBeDefined()
    await rpc('events/subscribe', params)
    const request = ansRequest()
    request.headers.set('cf-webhook-auth', 'forged')
    expect((await exports.default.fetch(request)).status).toBe(401)
    expect(
      (await exports.default.fetch(ansRequest(undefined, { account_id: 'b'.repeat(32) }))).status
    ).toBe(403)
    expect(deliveries).toHaveLength(0)
  })

  it('serializes overlapping local subscriptions and keeps one resource set', async () => {
    const results = await Promise.all([
      rpc('events/subscribe', params),
      rpc('events/subscribe', params)
    ])
    expect(results[0].result?.id).toBeTruthy()
    expect(results[1].result?.id).toBe(results[0].result?.id)
    expect([...resources.values()].every((collection) => collection.size === 1)).toBe(true)
  })

  it('rejects invalid trigger combinations before provisioning', async () => {
    for (const args of [
      { account_id: accountId },
      { ...params.arguments, afterInactivitySeconds: 3600 },
      { account_id: accountId, filters: { services: ['checkout'] } }
    ]) {
      expect((await rpc('events/subscribe', { ...params, arguments: args })).error?.code).toBe(
        -32602
      )
    }
    expect([...resources.values()].every((collection) => collection.size === 0)).toBe(true)
  })

  it('honors policy edits made through the existing API', async () => {
    await rpc('events/subscribe', params)
    const policy = [...records(POLICIES).values()][0]
    policy.enabled = false
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    policy.enabled = true
    policy.mechanisms = { webhooks: [] }
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(deliveries).toHaveLength(0)
  })

  it('fails closed when stored policy metadata is changed', async () => {
    await rpc('events/subscribe', params)
    const policy = [...records(POLICIES).values()][0]
    policy.description = 'changed'
    expect((await exports.default.fetch(ansRequest())).status).toBe(503)
    expect(deliveries).toHaveLength(0)
  })

  it('never follows a callback redirect', async () => {
    await rpc('events/subscribe', params)
    server.use(
      http.post(
        callbackUrl,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { Location: 'https://127.0.0.1/private' }
          })
      )
    )
    expect((await exports.default.fetch(ansRequest())).status).toBe(503)
    expect(deliveries).toHaveLength(0)
  })
})

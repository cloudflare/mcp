import { env, exports } from 'cloudflare:workers'
import { getOAuthApi } from '@cloudflare/workers-oauth-provider'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOMATIONS, POLICIES, WEBHOOKS } from '../src/events/api'
import { USER_AGENT } from '../src/constants'
import { decryptState } from '../src/events/state'
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
    capabilities?: { events?: object; extensions?: Record<string, unknown> }
    events?: unknown[]
  }
  error?: { code: number; data?: Record<string, unknown> }
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

/**
 * Everything this server stores about subscriptions, decrypted wherever it can
 * decrypt it: KV values and the policy descriptions it writes into ANS. The
 * destination secret is excluded: ANS holds it and we cannot read it back.
 */
async function storedByServer(): Promise<string> {
  const { keys } = await env.OAUTH_KV.list({ prefix: 'mcp-events:' })
  const kv = await Promise.all(keys.map(({ name }) => env.OAUTH_KV.get(name)))
  const policies = await Promise.all(
    [...records(POLICIES).values()].map(async (policy) =>
      JSON.stringify(
        await decryptState(
          env,
          `policy:${String(policy.name).slice('MCP Events '.length)}`,
          String(policy.description)
        )
      )
    )
  )
  return JSON.stringify([kv, policies])
}

function ansRequest(destination = [...records(WEBHOOKS).values()][0], overrides = {}) {
  const policy = [...records(POLICIES).values()][0]
  return new Request(destination.url as string, {
    method: 'POST',
    headers: { 'cf-webhook-auth': destination.secret as string },
    // The shape of a real Workers issue alert from ANS (2026-10-12). It has no
    // account_id; the policy ID binds it to the account.
    body: JSON.stringify({
      name: destination.name,
      text: 'Checkout issue',
      ts: 1_800_000_000,
      policy_id: policy?.id ?? 'deleted',
      policy_name: destination.name,
      alert_type: 'workers_observability_real_time_issue',
      alert_event: 'ALERT_STATE_EVENT_START',
      alert_correlation_id: 'vega-persisted-run-1',
      data: {
        issue: {
          id: 'issue-1',
          fingerprint: 'fp-1',
          title: 'Unhandled exception',
          type: 'exception',
          status: 'active',
          count: '9',
          first_observed: '2026-10-12T16:00:00Z',
          last_observed: '2026-10-12T16:05:00Z',
          services: [
            {
              name: 'checkout',
              type: 'worker',
              first_observed: '2026-10-12T16:00:00Z',
              last_observed: '2026-10-12T16:05:00Z'
            }
          ]
        },
        state_correlation_id: 'state-1',
        state_event: 'ALERT_STATE_EVENT_START'
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
      expect(request.headers.get('User-Agent')).toBe(USER_AGENT)
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
      // The real automations list is unpaginated and rejects page/per_page with 400.
      const search = new URL(request.url).searchParams
      if (
        collection === AUTOMATIONS &&
        request.method === 'GET' &&
        (search.has('page') || search.has('per_page'))
      )
        return HttpResponse.json({ success: false, errors: [] }, { status: 400 })
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
      // Like real ANS: a destination keeps the secret it was created with.
      if (collection === WEBHOOKS && request.method === 'PUT' && records.has(id))
        value.secret = records.get(id)!.secret
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
    const subscribed = await rpc('events/subscribe', params, issued.access_token)
    expect(subscribed.error).toBeUndefined()
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(deliveries).toHaveLength(1)

    // Neither the MCP token nor the upstream Cloudflare token is stored.
    const stored = await storedByServer()
    expect(stored).not.toContain(issued.access_token)
    expect(stored).not.toContain(token)

    // Revoking the grant blocks the next refresh; with no stored credential,
    // delivery continues only until the granted expiry.
    const summary = await helpers.unwrapToken(issued.access_token)
    await helpers.revokeGrant(summary!.grantId, summary!.userId)
    expect(
      (await rpc('events/subscribe', params, issued.access_token).catch(() => null))?.result
    ).toBeUndefined()
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(deliveries).toHaveLength(2)
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(subscribed.result!.refreshBefore!) + 1)
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(deliveries).toHaveLength(2)
  })
  it('advertises a catalogue of event types without creating resources', async () => {
    const capabilities = (await rpc('server/discover')).result?.capabilities
    expect(capabilities?.events).toEqual({ listChanged: false })
    expect(capabilities?.extensions).toHaveProperty(['io.modelcontextprotocol/skills'])
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
    // The draft's unsubscribe sends delivery as `{ url }` alone.
    const delivery = { url: params.delivery.url }
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
    // A new destination holds the new secret; the old one is gone, and the
    // policy points at the new one.
    expect([...resources.values()].every((collection) => collection.size === 1)).toBe(true)
    const [destination] = [...records(WEBHOOKS).values()]
    expect([...records(POLICIES).values()][0].mechanisms).toEqual({
      webhooks: [{ id: destination.id }]
    })
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(deliveries).toHaveLength(1)
  })

  it('ignores a replaced destination that ANS still calls', async () => {
    await rpc('events/subscribe', params)
    const old = { ...[...records(WEBHOOKS).values()][0] }
    const replacement = `whsec_${btoa('b'.repeat(32))}`
    validKeys = [replacement]
    await rpc('events/subscribe', {
      ...params,
      delivery: { ...params.delivery, secret: replacement }
    })
    expect((await exports.default.fetch(ansRequest(old))).status).toBe(204)
    expect(deliveries).toHaveLength(0)
  })

  it('reuses the destination when a refresh keeps the same signing secret', async () => {
    await rpc('events/subscribe', params)
    const [before] = [...records(WEBHOOKS).values()]
    bootstrapCount = 0
    await rpc('events/subscribe', params)
    expect([...records(WEBHOOKS).values()].map(({ id }) => id)).toEqual([before.id])
    expect(bootstrapCount).toBe(0)
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
    const failed = await rpc('events/subscribe', params)
    expect(failed.error?.code).toBe(-32015)
    expect(failed.error?.data).toEqual({ reason: 'challenge_failed' })
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

  it('keeps delivering after a refresh extends the subscription past its first expiry', async () => {
    const initial = await rpc('events/subscribe', { ...params, ttlMs: 10 * 60_000 })
    const firstExpiry = Date.parse(initial.result!.refreshBefore!)
    // Refresh shortly before expiry, with a longer lifetime.
    vi.spyOn(Date, 'now').mockReturnValue(firstExpiry - 60_000)
    const refreshed = await rpc('events/subscribe', { ...params, ttlMs: 30 * 60_000 })
    expect(Date.parse(refreshed.result!.refreshBefore!)).toBeGreaterThan(firstExpiry)
    // Past the first expiry: the destination never changed, but the KV record did.
    vi.spyOn(Date, 'now').mockReturnValue(firstExpiry + 60_000)
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(deliveries).toHaveLength(1)
  })

  it('stops forwarding on unsubscribe even when ANS cleanup fails', async () => {
    await rpc('events/subscribe', params)
    const destination = [...records(WEBHOOKS).values()][0]
    failNext = `GET ${POLICIES}`
    const { secret: _secret, ...delivery } = params.delivery
    expect((await rpc('events/unsubscribe', { ...params, delivery })).error).toBeDefined()
    expect((await exports.default.fetch(ansRequest(destination))).status).toBe(204)
    expect(deliveries).toHaveLength(0)
  })

  it('stores no token or signing secret; only ANS holds the sealed secret', async () => {
    await rpc('events/subscribe', params)
    const stored = await storedByServer()
    expect(stored).toContain('signingSecretHash')
    expect(stored).not.toContain(signingSecret)
    expect(stored).not.toContain(signingSecret.slice('whsec_'.length))
    expect(stored).not.toContain(token)
    const { keys } = await env.OAUTH_KV.list({ prefix: 'mcp-events:' })
    expect(keys.map(({ name }) => name)).toEqual([
      expect.stringMatching(/^mcp-events:subscription:sub_/)
    ])
    // The signing secret travels only inside the ANS destination secret.
    expect(String([...records(WEBHOOKS).values()][0].secret)).not.toContain(signingSecret)
  })

  it('drops a delivery the receiver rejects with 410 but keeps the subscription', async () => {
    await rpc('events/subscribe', params)
    callbackStatus = 410
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect([...records(POLICIES).values()][0].enabled).toBe(true)
    callbackStatus = 204
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(deliveries).toHaveLength(2)
  })

  it('re-checks access on refresh and stops delivering at expiry once it fails', async () => {
    const subscribed = await rpc('events/subscribe', params)
    policyReadStatus = 403
    expect((await rpc('events/subscribe', params)).error?.code).toBe(-32012)
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(subscribed.result!.refreshBefore!) + 1)
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(deliveries).toHaveLength(0)
  })

  it('forwards an alert without calling the Cloudflare API', async () => {
    await rpc('events/subscribe', params)
    requests.length = 0
    expect((await exports.default.fetch(ansRequest())).status).toBe(204)
    expect(requests).toHaveLength(0)
    expect(deliveries).toHaveLength(1)
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

  it('accepts the draft subscribe fields and clamps the requested lifetime', async () => {
    const result = await rpc('events/subscribe', {
      ...params,
      cursor: 'opaque-cursor',
      maxAgeMs: 300_000,
      ttlMs: 1
    })
    expect(result.error).toBeUndefined()
    expect(result.result).toMatchObject({ cursor: null, truncated: false })
  })

  it('answers unknown events with NotFound before provisioning', async () => {
    const result = await rpc('events/subscribe', {
      ...params,
      name: 'cloudflare.alert.http_alert_origin_error'
    })
    expect(result.error?.code).toBe(-32011)
    expect(result.error?.data).toEqual({ kind: 'event' })
    expect([...resources.values()].every((collection) => collection.size === 0)).toBe(true)
  })

  it('describes the event with a schema ChatGPT accepts', async () => {
    const list = await rpc('events/list')
    const [event] = (list.result?.events ?? []) as Array<{
      inputSchema: Record<string, unknown>
      payloadSchema: Record<string, unknown>
    }>
    for (const schema of [event.inputSchema, event.payloadSchema]) {
      expect(schema.type).toBe('object')
      for (const key of ['$schema', 'oneOf', 'anyOf', 'allOf', 'not'])
        expect(schema).not.toHaveProperty(key)
    }
  })

  it('notifies on new issues when no trigger is given', async () => {
    const { afterOccurrences: _trigger, ...args } = params.arguments
    expect((await rpc('events/subscribe', { ...params, arguments: args })).error).toBeUndefined()
    expect([...records(AUTOMATIONS).values()][0]).toMatchObject({ afterOccurrences: 1 })
  })

  it('rejects invalid trigger combinations before provisioning', async () => {
    for (const args of [
      { ...params.arguments, afterInactivitySeconds: 3600 },
      { account_id: accountId, filters: { services: ['checkout'] } }
    ]) {
      expect((await rpc('events/subscribe', { ...params, arguments: args })).error?.code).toBe(
        -32602
      )
    }
    expect([...resources.values()].every((collection) => collection.size === 0)).toBe(true)
  })

  it('refuses to refresh when stored policy metadata is changed', async () => {
    await rpc('events/subscribe', params)
    const policy = [...records(POLICIES).values()][0]
    policy.description = 'changed'
    expect((await rpc('events/subscribe', params)).error).toBeDefined()
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

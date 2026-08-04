import { CimdFetchError, type OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cfAccountsSuccess, cfSuccess } from '../helpers/cloudflare-api'
import { clearKv } from '../helpers/kv'
import { modernMcpRequest, parseMcpResult } from '../helpers/mcp'
import { server } from '../setup/msw'

/**
 * Worker-seam tests for the OAuth route layer (`createAuthHandlers` in
 * src/auth/oauth-handler.ts), driven end to end through `exports.default.fetch`
 * — exactly how the deployed worker serves them via OAuthProvider. Exercises
 * the consent dialog, the route-level error paths, and the `auth_user` metrics
 * those paths emit (none of which had coverage before).
 *
 * Real auth, real OAUTH_KV, real OAuthProvider; the only mock is the
 * MCP_METRICS Analytics Engine binding, spied so we can assert the `auth_user`
 * datapoints without querying Analytics Engine.
 */

const REDIRECT_URI = 'https://app.example.com/cb'
const MCP_ORIGIN = 'https://mcp.cloudflare.com'
const DOWNSTREAM_CODE_VERIFIER = 'test-downstream-code-verifier'
const DOWNSTREAM_CODE_CHALLENGE = 'I4fhllfHqqQsgap17V2SDI0scSei8H7U0e0rZBDIcbo'

/** Register a client via the provider's RFC 7591 endpoint; returns its id. */
async function registerClient(): Promise<string> {
  const res = await exports.default.fetch(
    new Request(`${MCP_ORIGIN}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none'
      })
    })
  )
  expect(res.status).toBe(201)
  return ((await res.json()) as { client_id: string }).client_id
}

function authorizeUrl(params: Record<string, string>): string {
  const u = new URL(`${MCP_ORIGIN}/authorize`)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  u.searchParams.set('code_challenge', DOWNSTREAM_CODE_CHALLENGE)
  u.searchParams.set('code_challenge_method', 'S256')
  return u.toString()
}

function embeddedTemplateScopes(html: string): Record<string, string[]> {
  const encoded = html.match(/const TEMPLATES = ([^;]+);/)?.[1]
  expect(encoded).toBeTruthy()
  return JSON.parse(encoded!) as Record<string, string[]>
}

function embeddedInitialScopes(html: string): string[] {
  const encoded = html.match(/const INITIAL_SCOPES = ([^;]+);/)?.[1]
  expect(encoded).toBeTruthy()
  return JSON.parse(encoded!) as string[]
}

async function beginAuthorization(options: { state?: string; scopes?: string } = {}): Promise<{
  clientId: string
  state: string
  sessionCookie: string
  location: string
}> {
  const clientId = await registerClient()
  const authRes = await exports.default.fetch(
    new Request(
      authorizeUrl({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: DOWNSTREAM_CODE_CHALLENGE,
        code_challenge_method: 'S256',
        scope: options.scopes ?? 'user:read',
        ...(options.state === undefined ? {} : { state: options.state })
      })
    )
  )
  const html = await authRes.text()
  const csrfCookie = cookiesFrom(authRes)
  const stateField = html.match(/name="state" value="([^"]+)"/)?.[1]
  const csrfField = html.match(/name="csrf_token" value="([^"]+)"/)?.[1]
  expect(stateField && csrfField).toBeTruthy()

  const postRes = await exports.default.fetch(
    new Request(`${MCP_ORIGIN}/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: csrfCookie },
      body: new URLSearchParams({
        state: stateField!,
        csrf_token: csrfField!,
        scopes: options.scopes ?? 'user:read'
      }).toString(),
      redirect: 'manual'
    })
  )
  expect(postRes.status).toBe(302)
  const location = postRes.headers.get('location')!
  return {
    clientId,
    state: new URL(location).searchParams.get('state')!,
    sessionCookie: cookiesFrom(postRes),
    location
  }
}

function useCloudflareAuthSuccess(scope = 'user:read'): {
  userCalls: () => number
  accountCalls: () => number
} {
  let userCalls = 0
  let accountCalls = 0
  server.use(
    http.post('https://dash.cloudflare.com/oauth2/token', () =>
      HttpResponse.json({
        access_token: 'access-token',
        expires_in: 3600,
        refresh_token: 'refresh-token',
        scope,
        token_type: 'bearer'
      })
    ),
    http.get('https://api.cloudflare.com/client/v4/user', () => {
      userCalls++
      return HttpResponse.json(cfSuccess({ id: 'user-1', email: 'user@example.com' }))
    }),
    http.get('https://api.cloudflare.com/client/v4/accounts', () => {
      accountCalls++
      return HttpResponse.json(cfAccountsSuccess([{ id: 'acc-1', name: 'Account One' }]))
    })
  )
  return { userCalls: () => userCalls, accountCalls: () => accountCalls }
}

/** Collapse a response's Set-Cookie header(s) into a Cookie request header. */
function cookiesFrom(res: Response): string {
  const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']
  return raw
    .filter(Boolean)
    .map((c) => c.split(';')[0])
    .join('; ')
}

type Datapoint = { indexes?: string[]; blobs?: Array<string | null> }

/** Index1 values of every datapoint written via the spied MCP_METRICS binding. */
function writtenEvents(spy: ReturnType<typeof vi.spyOn>): string[] {
  return (spy.mock.calls as unknown[][]).map((args) => (args[0] as Datapoint)?.indexes?.[0] ?? '')
}

let metricsSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  metricsSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await clearKv(env.OAUTH_KV)
})

describe('GET /authorize', () => {
  it('renders the consent dialog for a registered client', async () => {
    const clientId = await registerClient()

    const res = await exports.default.fetch(
      new Request(
        authorizeUrl({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          code_challenge: DOWNSTREAM_CODE_CHALLENGE,
          code_challenge_method: 'S256',
          scope: 'user:read'
        })
      )
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    // Consent form with CSRF protection and a session-binding cookie.
    expect(body).toContain('<form')
    expect(res.headers.get('Set-Cookie')).toBeTruthy()
    // The picker uses the canonical production API catalog and preserves custom templates.
    expect(body).toContain('data-scope="dns.read"')
    expect(body).toContain('data-category="DNS &amp; Zones"')
    expect(body).not.toContain('data-scope="dns_records:read"')
    expect(body).toContain('cf-mcp-consent:user-templates:v1')
    expect(body).toContain('Save as template')

    const templates = embeddedTemplateScopes(body)
    expect(Object.keys(templates)).toEqual(['read-only', 'full-access'])
    expect(templates['read-only']).toHaveLength(194)
    expect(templates['read-only']).toContain('teams-pii.read')
    expect(templates['full-access']).toHaveLength(384)
    expect(templates['full-access']).toContain('logs.write')
    expect(templates['full-access']).toContain('ssl-and-certificates.read')
    expect(templates['read-only']).toContain('realtime.read')
    expect(templates['full-access']).toContain('realtime.read')
    expect(templates['full-access']).not.toContain('realtime.realtime')
    // Happy path emits no auth_user event.
    expect(writtenEvents(metricsSpy)).not.toContain('auth_user')
  })

  it('preserves valid requested scopes and preselects them with required scopes', async () => {
    const clientId = await registerClient()
    const response = await exports.default.fetch(
      new Request(
        authorizeUrl({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          scope: 'access.write'
        })
      )
    )

    expect(response.status).toBe(200)
    expect(embeddedInitialScopes(await response.text())).toEqual([
      'access.write',
      'user:read',
      'offline_access',
      'account:read'
    ])
  })

  it('rejects unknown requested scopes instead of silently downgrading them', async () => {
    const clientId = await registerClient()
    const response = await exports.default.fetch(
      new Request(
        authorizeUrl({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          scope: 'access:write'
        })
      )
    )

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Unknown OAuth scope: access:write')
  })

  it('always shows consent, including for repeated read-only requests', async () => {
    const clientId = await registerClient()
    const request = () =>
      new Request(
        authorizeUrl({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          scope: 'user:read'
        })
      )

    const firstResponse = await exports.default.fetch(request())
    const secondResponse = await exports.default.fetch(request())

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(await firstResponse.text()).toContain('<form')
    expect(await secondResponse.text()).toContain('<form')
  })

  it('silently drops stale custom-template scopes outside the catalog', async () => {
    const clientId = await registerClient()
    const authRes = await exports.default.fetch(
      new Request(
        authorizeUrl({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          code_challenge: DOWNSTREAM_CODE_CHALLENGE,
          code_challenge_method: 'S256',
          scope: 'user:read'
        })
      )
    )
    const html = await authRes.text()
    const state = html.match(/name="state" value="([^"]+)"/)?.[1]
    const csrfToken = html.match(/name="csrf_token" value="([^"]+)"/)?.[1]
    expect(state && csrfToken).toBeTruthy()

    const form = new URLSearchParams({ state: state!, csrf_token: csrfToken! })
    form.append('scopes', 'dns.read')
    form.append('scopes', 'removed-from-catalog.read')
    const response = await exports.default.fetch(
      new Request(`${MCP_ORIGIN}/authorize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookiesFrom(authRes)
        },
        body: form.toString(),
        redirect: 'manual'
      })
    )

    expect(response.status).toBe(302)
    const forwardedScopes = new URL(response.headers.get('location')!).searchParams
      .get('scope')!
      .split(' ')
    expect(forwardedScopes).toContain('dns.read')
    expect(forwardedScopes).toContain('user:read')
    expect(forwardedScopes).toContain('account:read')
    expect(forwardedScopes).toContain('offline_access')
    expect(forwardedScopes).not.toContain('removed-from-catalog.read')
  })

  it('does not redirect a known client with an invalid redirect URI', async () => {
    const clientId = await registerClient()
    const response = await exports.default.fetch(
      new Request(
        authorizeUrl({
          response_type: 'code',
          client_id: clientId,
          redirect_uri: 'https://attacker.example/callback',
          code_challenge: DOWNSTREAM_CODE_CHALLENGE,
          code_challenge_method: 'S256'
        })
      ),
      { redirect: 'manual' }
    )

    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toContain('Invalid redirect URI')
  })

  it('redirects a known client PKCE error with state and issuer', async () => {
    const clientId = await registerClient()
    const url = new URL(`${MCP_ORIGIN}/authorize`)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      state: 'client-state'
    }).toString()
    const response = await exports.default.fetch(new Request(url), { redirect: 'manual' })

    expect(response.status).toBe(302)
    const redirect = new URL(response.headers.get('location')!)
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI)
    expect(redirect.searchParams.get('error')).toBe('invalid_request')
    expect(redirect.searchParams.get('state')).toBe('client-state')
    expect(redirect.searchParams.get('iss')).toBe(MCP_ORIGIN)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('redirects an unsupported response type with the correct OAuth code', async () => {
    const clientId = await registerClient()
    const response = await exports.default.fetch(
      new Request(
        authorizeUrl({
          response_type: 'unsupported',
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          state: 'client-state',
          code_challenge: DOWNSTREAM_CODE_CHALLENGE,
          code_challenge_method: 'S256'
        })
      ),
      { redirect: 'manual' }
    )

    expect(response.status).toBe(302)
    const redirect = new URL(response.headers.get('location')!)
    expect(redirect.searchParams.get('error')).toBe('unsupported_response_type')
    expect(redirect.searchParams.get('state')).toBe('client-state')
    expect(redirect.searchParams.get('iss')).toBe(MCP_ORIGIN)
  })

  it('returns a local invalid_request page for an unknown client', async () => {
    const res = await exports.default.fetch(
      new Request(
        authorizeUrl({
          response_type: 'code',
          client_id: 'does-not-exist',
          redirect_uri: REDIRECT_URI,
          code_challenge: DOWNSTREAM_CODE_CHALLENGE,
          code_challenge_method: 'S256'
        })
      )
    )

    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Invalid client_id')
    expect(writtenEvents(metricsSpy)).not.toContain('auth_user')
  })

  it('returns a local retryable error when CIMD metadata resolution fails', async () => {
    vi.spyOn(
      (env as Env & { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER,
      'lookupClient'
    ).mockRejectedValueOnce(
      new CimdFetchError('https://client.example.com/oauth.json', new Error('upstream timeout'))
    )

    const response = await exports.default.fetch(
      new Request(
        authorizeUrl({
          response_type: 'code',
          client_id: 'https://client.example.com/oauth.json',
          redirect_uri: REDIRECT_URI,
          code_challenge: DOWNSTREAM_CODE_CHALLENGE,
          code_challenge_method: 'S256'
        })
      )
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('30')
    expect(await response.text()).toContain('Client metadata is temporarily unavailable')
    expect(writtenEvents(metricsSpy)).not.toContain('auth_user')
  })

  it('returns a local invalid_request page when client_id is missing', async () => {
    const response = await exports.default.fetch(
      new Request(
        authorizeUrl({
          response_type: 'code',
          redirect_uri: REDIRECT_URI,
          code_challenge: DOWNSTREAM_CODE_CHALLENGE,
          code_challenge_method: 'S256'
        })
      )
    )

    expect(response.status).toBe(400)
    expect(await response.text()).toContain('client_id is required')
    expect(writtenEvents(metricsSpy)).not.toContain('auth_user')
  })
})

describe('GET /oauth/callback', () => {
  it('completes the full login flow and redirects back to the client with a code', async () => {
    const { state: cfState, sessionCookie } = await beginAuthorization()

    // The state forwarded to Cloudflare is an opaque token (RFC 6749 §10.12),
    // not a base64-encoded AuthRequest. Decoding it must NOT yield JSON with
    // request fields like client_id/redirect_uri (the pre-opaque-state shape).
    let decodedAsJson: unknown
    try {
      decodedAsJson = JSON.parse(atob(cfState))
    } catch {
      decodedAsJson = null
    }
    expect(decodedAsJson).not.toMatchObject({ clientId: expect.anything() })
    expect(decodedAsJson).not.toMatchObject({ redirectUri: expect.anything() })

    useCloudflareAuthSuccess()

    // GET /oauth/callback -> 302 back to the client redirect URI with a code.
    const cbRes = await exports.default.fetch(
      new Request(
        `${MCP_ORIGIN}/oauth/callback?code=authcode&state=${encodeURIComponent(cfState)}`,
        { headers: { Cookie: sessionCookie }, redirect: 'manual' }
      )
    )

    expect(cbRes.status).toBe(302)
    const redirect = new URL(cbRes.headers.get('location')!)
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI)
    expect(redirect.searchParams.get('code')).toBeTruthy()

    // A successful login records an auth_user datapoint with the userId (blob3)
    // and no error message (blob4).
    const authUserCall = (metricsSpy.mock.calls as unknown[][]).find(
      (args) => (args[0] as Datapoint)?.indexes?.[0] === 'auth_user'
    )
    expect(authUserCall).toBeTruthy()
    const dp = authUserCall![0] as Datapoint
    expect(dp.blobs?.[2]).toBe('user-1')
    expect(dp.blobs?.[3]).toBeFalsy()
  })

  it('carries a requested write scope through the complete OAuth exchange', async () => {
    const { clientId, state, sessionCookie, location } = await beginAuthorization({
      scopes: 'access.write'
    })
    const upstreamScopes = new URL(location).searchParams.get('scope')?.split(' ') ?? []
    expect(upstreamScopes).toEqual(
      expect.arrayContaining(['access.write', 'user:read', 'account:read', 'offline_access'])
    )

    useCloudflareAuthSuccess('access.write user:read account:read offline_access')
    const callback = await exports.default.fetch(
      new Request(`${MCP_ORIGIN}/oauth/callback?code=authcode&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: sessionCookie },
        redirect: 'manual'
      })
    )
    const code = new URL(callback.headers.get('location')!).searchParams.get('code')
    expect(code).toBeTruthy()

    const tokenResponse = await exports.default.fetch(
      new Request(`${MCP_ORIGIN}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code!,
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          code_verifier: DOWNSTREAM_CODE_VERIFIER
        }).toString()
      })
    )
    expect(tokenResponse.status).toBe(200)
    const token = (await tokenResponse.json()) as { scope: string }
    expect(token.scope.split(' ')).toEqual(
      expect.arrayContaining(['access.write', 'user:read', 'account:read', 'offline_access'])
    )
  })

  it('serves modern MCP without externally resolving the provider-issued token', async () => {
    const { clientId, state, sessionCookie } = await beginAuthorization()
    const probes = useCloudflareAuthSuccess()
    const callback = await exports.default.fetch(
      new Request(`${MCP_ORIGIN}/oauth/callback?code=authcode&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: sessionCookie },
        redirect: 'manual'
      })
    )
    const code = new URL(callback.headers.get('location')!).searchParams.get('code')
    expect(code).toBeTruthy()

    const tokenResponse = await exports.default.fetch(
      new Request(`${MCP_ORIGIN}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code!,
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          code_verifier: DOWNSTREAM_CODE_VERIFIER
        }).toString()
      })
    )
    expect(tokenResponse.status).toBe(200)
    const { access_token } = (await tokenResponse.json()) as { access_token: string }
    expect(probes.userCalls()).toBe(1)
    expect(probes.accountCalls()).toBe(1)

    const mcpResponse = await exports.default.fetch(modernMcpRequest(access_token, 'tools/list'))
    const mcpBody = await parseMcpResult(mcpResponse)

    expect(mcpResponse.status).toBe(200)
    expect(probes.userCalls()).toBe(1)
    expect(probes.accountCalls()).toBe(1)
    expect(mcpBody.result?.resultType).toBe('complete')
    expect(mcpBody.result?.tools?.map((tool) => tool.name)).toEqual(['docs', 'search', 'execute'])
  })

  it('preserves Unicode downstream client state without encoding it into upstream state', async () => {
    const downstreamState = 'client-state-🔐-你好'
    const { state, sessionCookie } = await beginAuthorization({ state: downstreamState })
    expect(state).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

    useCloudflareAuthSuccess()
    const res = await exports.default.fetch(
      new Request(`${MCP_ORIGIN}/oauth/callback?code=authcode&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: sessionCookie },
        redirect: 'manual'
      })
    )

    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location')!).searchParams.get('state')).toBe(downstreamState)
  })

  it('keeps the upstream authorization URL bounded for large downstream state', async () => {
    const short = await beginAuthorization({ state: 'short' })
    const large = await beginAuthorization({ state: 'x'.repeat(8192) })

    expect(large.location.length).toBe(short.location.length)
    expect(large.location.length).toBeLessThan(2048)
  })

  it('accepts an in-flight legacy base64-JSON state during deployment', async () => {
    const { state, sessionCookie } = await beginAuthorization()
    const legacyState = btoa(JSON.stringify({ state }))
    useCloudflareAuthSuccess()

    const res = await exports.default.fetch(
      new Request(
        `${MCP_ORIGIN}/oauth/callback?code=authcode&state=${encodeURIComponent(legacyState)}`,
        { headers: { Cookie: sessionCookie }, redirect: 'manual' }
      )
    )

    expect(res.status).toBe(302)
    expect(
      new URL(res.headers.get('location')!).origin + new URL(res.headers.get('location')!).pathname
    ).toBe(REDIRECT_URI)
  })

  it('rejects a valid state token without its session-binding cookie', async () => {
    const { state } = await beginAuthorization()

    const res = await exports.default.fetch(
      new Request(`${MCP_ORIGIN}/oauth/callback?code=authcode&state=${encodeURIComponent(state)}`, {
        redirect: 'manual'
      })
    )

    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Missing session binding')
  })

  it('rejects a valid state token bound to a different browser session', async () => {
    const first = await beginAuthorization()
    const second = await beginAuthorization()

    const res = await exports.default.fetch(
      new Request(
        `${MCP_ORIGIN}/oauth/callback?code=authcode&state=${encodeURIComponent(first.state)}`,
        { headers: { Cookie: second.sessionCookie }, redirect: 'manual' }
      )
    )

    expect(res.status).toBe(400)
    expect(await res.text()).toContain('State mismatch')
  })

  it('rejects replay after a state token has completed authorization', async () => {
    const { state, sessionCookie } = await beginAuthorization()
    useCloudflareAuthSuccess()
    const callbackUrl = `${MCP_ORIGIN}/oauth/callback?code=authcode&state=${encodeURIComponent(state)}`

    const first = await exports.default.fetch(
      new Request(callbackUrl, { headers: { Cookie: sessionCookie }, redirect: 'manual' })
    )
    expect(first.status).toBe(302)

    const replay = await exports.default.fetch(
      new Request(callbackUrl, { headers: { Cookie: sessionCookie }, redirect: 'manual' })
    )
    expect(replay.status).toBe(400)
    expect(await replay.text()).toContain('Invalid or expired state')
  })

  it('returns 400 invalid_request when the code is missing', async () => {
    const res = await exports.default.fetch(new Request(`${MCP_ORIGIN}/oauth/callback`))

    expect(res.status).toBe(400)
    expect(await res.text()).toContain('invalid_request')
  })

  it('logs an auth_user error when state is missing', async () => {
    const res = await exports.default.fetch(
      new Request(`${MCP_ORIGIN}/oauth/callback?code=authcode`)
    )

    // No state -> validateOAuthState throws -> caught -> auth_user error logged.
    expect(res.status).toBe(400)
    expect(writtenEvents(metricsSpy)).toContain('auth_user')
  })

  it.each([
    ['unknown', crypto.randomUUID()],
    ['malformed', 'not-a-uuid'],
    ['oversized', 'x'.repeat(1024)]
  ])('rejects an %s state token as invalid_request', async (_, state) => {
    const res = await exports.default.fetch(
      new Request(`${MCP_ORIGIN}/oauth/callback?code=authcode&state=${encodeURIComponent(state)}`, {
        headers: { Cookie: '__Host-CONSENTED_STATE=deadbeef' }
      })
    )

    expect(res.status).toBe(400)
    expect(await res.text()).toContain('invalid_request')
    expect(writtenEvents(metricsSpy)).toContain('auth_user')
  })
})

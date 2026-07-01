import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cfAccountsSuccess, cfSuccess } from '../helpers/cloudflare-api'
import { clearKv } from '../helpers/kv'
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

/** Register a client via the provider's RFC 7591 endpoint; returns its id. */
async function registerClient(): Promise<string> {
  const res = await exports.default.fetch(
    new Request('https://mcp.example.com/register', {
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
  const u = new URL('https://mcp.example.com/authorize')
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}

async function beginAuthorization(options: { state?: string; scopes?: string } = {}): Promise<{
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
        scope: 'user:read',
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
    new Request('https://mcp.example.com/authorize', {
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
    state: new URL(location).searchParams.get('state')!,
    sessionCookie: cookiesFrom(postRes),
    location
  }
}

function useCloudflareAuthSuccess(): void {
  server.use(
    http.post('https://dash.cloudflare.com/oauth2/token', () =>
      HttpResponse.json({
        access_token: 'access-token',
        expires_in: 3600,
        refresh_token: 'refresh-token',
        scope: 'user:read',
        token_type: 'bearer'
      })
    ),
    http.get('https://api.cloudflare.com/client/v4/user', () =>
      HttpResponse.json(cfSuccess({ id: 'user-1', email: 'user@example.com' }))
    ),
    http.get('https://api.cloudflare.com/client/v4/accounts', () =>
      HttpResponse.json(cfAccountsSuccess([{ id: 'acc-1', name: 'Account One' }]))
    )
  )
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
          scope: 'user:read'
        })
      )
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    // Consent form with CSRF protection and a session-binding cookie.
    expect(body).toContain('<form')
    expect(res.headers.get('Set-Cookie')).toBeTruthy()
    // Happy path emits no auth_user event.
    expect(writtenEvents(metricsSpy)).not.toContain('auth_user')
  })

  it('logs an auth_user error and 500s for an unknown client', async () => {
    const res = await exports.default.fetch(
      new Request(
        authorizeUrl({
          response_type: 'code',
          client_id: 'does-not-exist',
          redirect_uri: REDIRECT_URI
        })
      )
    )

    // OAuthProvider rejects the unknown client; the route maps it to an error
    // page and records an auth_user failure datapoint.
    expect(res.status).toBe(500)
    expect(writtenEvents(metricsSpy)).toContain('auth_user')
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
        `https://mcp.example.com/oauth/callback?code=authcode&state=${encodeURIComponent(cfState)}`,
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

  it('preserves Unicode downstream client state without encoding it into upstream state', async () => {
    const downstreamState = 'client-state-🔐-你好'
    const { state, sessionCookie } = await beginAuthorization({ state: downstreamState })
    expect(state).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

    useCloudflareAuthSuccess()
    const res = await exports.default.fetch(
      new Request(
        `https://mcp.example.com/oauth/callback?code=authcode&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: sessionCookie }, redirect: 'manual' }
      )
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
        `https://mcp.example.com/oauth/callback?code=authcode&state=${encodeURIComponent(legacyState)}`,
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
      new Request(
        `https://mcp.example.com/oauth/callback?code=authcode&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' }
      )
    )

    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Missing session binding')
  })

  it('rejects a valid state token bound to a different browser session', async () => {
    const first = await beginAuthorization()
    const second = await beginAuthorization()

    const res = await exports.default.fetch(
      new Request(
        `https://mcp.example.com/oauth/callback?code=authcode&state=${encodeURIComponent(first.state)}`,
        { headers: { Cookie: second.sessionCookie }, redirect: 'manual' }
      )
    )

    expect(res.status).toBe(400)
    expect(await res.text()).toContain('State mismatch')
  })

  it('rejects replay after a state token has completed authorization', async () => {
    const { state, sessionCookie } = await beginAuthorization()
    useCloudflareAuthSuccess()
    const callbackUrl = `https://mcp.example.com/oauth/callback?code=authcode&state=${encodeURIComponent(state)}`

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
    const res = await exports.default.fetch(new Request('https://mcp.example.com/oauth/callback'))

    expect(res.status).toBe(400)
    expect(await res.text()).toContain('invalid_request')
  })

  it('logs an auth_user error when state is missing', async () => {
    const res = await exports.default.fetch(
      new Request('https://mcp.example.com/oauth/callback?code=authcode')
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
      new Request(
        `https://mcp.example.com/oauth/callback?code=authcode&state=${encodeURIComponent(state)}`,
        { headers: { Cookie: '__Host-CONSENTED_STATE=deadbeef' } }
      )
    )

    expect(res.status).toBe(400)
    expect(await res.text()).toContain('invalid_request')
    expect(writtenEvents(metricsSpy)).toContain('auth_user')
  })
})

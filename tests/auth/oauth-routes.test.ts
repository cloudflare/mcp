import { exports } from 'cloudflare:workers'
import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKv } from '../helpers/kv'

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

/** Index1 values of every datapoint written via the spied MCP_METRICS binding. */
function writtenEvents(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map(([dp]) => (dp as { indexes?: string[] })?.indexes?.[0] ?? '')
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
  it('returns 400 invalid_request when the code is missing', async () => {
    const res = await exports.default.fetch(
      new Request('https://mcp.example.com/oauth/callback')
    )

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

  it('rejects an unknown/expired state token', async () => {
    const stateQuery = btoa(JSON.stringify({ clientId: 'c', state: 'never-stored' }))
    const res = await exports.default.fetch(
      new Request(
        `https://mcp.example.com/oauth/callback?code=authcode&state=${encodeURIComponent(stateQuery)}`,
        { headers: { Cookie: '__Host-CONSENTED_STATE=deadbeef' } }
      )
    )

    expect(res.status).toBe(400)
    expect(await res.text()).toContain('invalid_request')
    expect(writtenEvents(metricsSpy)).toContain('auth_user')
  })
})

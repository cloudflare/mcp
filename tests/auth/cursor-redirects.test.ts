import { env, exports } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import { clearKv } from '../helpers/kv'

const MCP_ORIGIN = 'https://mcp.cloudflare.com'
const DOWNSTREAM_CODE_CHALLENGE = 'I4fhllfHqqQsgap17V2SDI0scSei8H7U0e0rZBDIcbo'

// What some Cursor versions register (seen in production): a private-use callback next to
// https and loopback ones. Cursor signs in with the loopback (or the https) one.
const CURSOR_REDIRECT_URIS = [
  'cursor://anysphere.cursor-mcp/oauth/callback',
  'https://www.cursor.com/agents/mcp/oauth/callback',
  'http://localhost:8787/callback'
]

function register(redirectUris: string[]): Promise<Response> {
  return exports.default.fetch(
    new Request(`${MCP_ORIGIN}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Cursor',
        redirect_uris: redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      })
    })
  )
}

function authorize(clientId: string, redirectUri: string): Promise<Response> {
  const url = new URL(`${MCP_ORIGIN}/authorize`)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: `${MCP_ORIGIN}/mcp`,
    scope: 'user:read',
    state: 'client-state',
    code_challenge: DOWNSTREAM_CODE_CHALLENGE,
    code_challenge_method: 'S256'
  }).toString()
  return exports.default.fetch(new Request(url), { redirect: 'manual' })
}

describe('Cursor registrations with a cursor:// callback', () => {
  afterEach(async () => {
    await clearKv(env.OAUTH_KV)
  })

  it("accepts Cursor's registration and signs in through its loopback callback", async () => {
    const registration = await register(CURSOR_REDIRECT_URIS)
    expect(registration.status).toBe(201)
    const { client_id: clientId } = (await registration.json()) as { client_id: string }

    const consent = await authorize(clientId, 'http://localhost:8787/callback')
    expect(consent.status).toBe(200)
    expect(await consent.text()).toContain('name="handle"')
  })

  it('still refuses an authorization that uses the private-use callback, without redirecting', async () => {
    const registration = await register(CURSOR_REDIRECT_URIS)
    const { client_id: clientId } = (await registration.json()) as { client_id: string }

    const refused = await authorize(clientId, 'cursor://anysphere.cursor-mcp/oauth/callback')
    expect(refused.status).toBe(400)
    expect(refused.headers.get('location')).toBeNull()
    // workers-oauth-provider holds the URI each request uses to https or loopback http.
    expect(await refused.text()).toContain('Invalid redirect URI')
    expect((await env.OAUTH_KV.list({ prefix: 'grant:' })).keys).toHaveLength(0)
  })

  it('still refuses a registration with a remote http callback', async () => {
    const registration = await register(['http://remote.example/callback'])
    expect(registration.status).toBe(400)
    await expect(registration.json()).resolves.toMatchObject({ error: 'invalid_client_metadata' })
  })
})

import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { cfAccountsSuccess, cfSuccess } from '../helpers/cloudflare-api'
import { clearKv } from '../helpers/kv'
import { modernMcpRequest, parseMcpResult } from '../helpers/mcp'
import { server } from '../setup/msw'

const MCP_ORIGIN = 'https://mcp.cloudflare.com'
const MCP_RESOURCE = `${MCP_ORIGIN}/mcp`
const REDIRECT_URI = 'https://client.example.com/callback'
const CIMD_CLIENT_ID = 'https://client.example.com/oauth/client.json'
const DOWNSTREAM_CODE_VERIFIER = 'test-downstream-code-verifier'
const DOWNSTREAM_CODE_CHALLENGE = 'I4fhllfHqqQsgap17V2SDI0scSei8H7U0e0rZBDIcbo'

function cimdMetadata(clientId = CIMD_CLIENT_ID, redirectUri = REDIRECT_URI) {
  return {
    client_id: clientId,
    client_name: 'CIMD Test Client',
    client_uri: 'https://client.example.com',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  }
}

function authorizeUrl(
  clientId = CIMD_CLIENT_ID,
  redirectUri = REDIRECT_URI,
  resource = MCP_RESOURCE
): string {
  const url = new URL(`${MCP_ORIGIN}/authorize`)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    resource,
    scope: 'user:read',
    state: 'client-state',
    code_challenge: DOWNSTREAM_CODE_CHALLENGE,
    code_challenge_method: 'S256'
  }).toString()
  return url.href
}

function cookiesFrom(response: Response): string {
  const values = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? '']
  return values
    .filter(Boolean)
    .map((value) => value.split(';')[0])
    .join('; ')
}

function useCloudflareAuthSuccess(): void {
  server.use(
    http.post('https://dash.cloudflare.com/oauth2/token', () =>
      HttpResponse.json({
        access_token: 'access-token',
        expires_in: 3600,
        refresh_token: 'refresh-token',
        scope: 'user:read account:read offline_access',
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

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
})

describe('Client ID Metadata Documents', () => {
  it('advertises CIMD while retaining dynamic registration fallback', async () => {
    const response = await exports.default.fetch(
      new Request(`${MCP_ORIGIN}/.well-known/oauth-authorization-server`)
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      client_id_metadata_document_supported: true,
      registration_endpoint: `${MCP_ORIGIN}/register`
    })
  })

  it('completes a public-client flow without persisting a phantom client', async () => {
    let metadataFetches = 0
    server.use(
      http.get(CIMD_CLIENT_ID, () => {
        metadataFetches++
        return HttpResponse.json(cimdMetadata())
      })
    )

    const authorization = await exports.default.fetch(new Request(authorizeUrl()))
    expect(authorization.status).toBe(200)
    const html = await authorization.text()
    expect(html).toContain('CIMD Test Client')

    const state = html.match(/name="state" value="([^"]+)"/)?.[1]
    const csrfToken = html.match(/name="csrf_token" value="([^"]+)"/)?.[1]
    expect(state && csrfToken).toBeTruthy()

    const approval = await exports.default.fetch(
      new Request(`${MCP_ORIGIN}/authorize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookiesFrom(authorization)
        },
        body: new URLSearchParams({
          state: state!,
          csrf_token: csrfToken!,
          scopes: 'user:read'
        }).toString(),
        redirect: 'manual'
      })
    )
    expect(approval.status).toBe(302)
    const upstreamState = new URL(approval.headers.get('location')!).searchParams.get('state')
    expect(upstreamState).toBeTruthy()

    useCloudflareAuthSuccess()
    const callback = await exports.default.fetch(
      new Request(
        `${MCP_ORIGIN}/oauth/callback?code=authcode&state=${encodeURIComponent(upstreamState!)}`,
        { headers: { Cookie: cookiesFrom(approval) }, redirect: 'manual' }
      )
    )
    expect(callback.status).toBe(302)
    const redirect = new URL(callback.headers.get('location')!)
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT_URI)
    expect(redirect.searchParams.get('state')).toBe('client-state')
    expect(redirect.searchParams.get('iss')).toBe(MCP_ORIGIN)
    const code = redirect.searchParams.get('code')
    expect(code).toBeTruthy()

    const tokenResponse = await exports.default.fetch(
      new Request(`${MCP_ORIGIN}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code!,
          client_id: CIMD_CLIENT_ID,
          redirect_uri: REDIRECT_URI,
          code_verifier: DOWNSTREAM_CODE_VERIFIER,
          resource: MCP_RESOURCE
        }).toString()
      })
    )
    expect(tokenResponse.status).toBe(200)
    const tokens = (await tokenResponse.json()) as { access_token: string; resource: string }
    expect(tokens.resource).toBe(MCP_RESOURCE)

    const mcpResponse = await exports.default.fetch(
      modernMcpRequest(tokens.access_token, 'tools/list')
    )
    const mcpBody = await parseMcpResult(mcpResponse)
    expect(mcpResponse.status).toBe(200)
    expect(mcpBody.result?.tools?.map((tool) => tool.name)).toEqual(['docs', 'search', 'execute'])

    expect(metadataFetches).toBeGreaterThan(0)
    expect((await env.OAUTH_KV.list({ prefix: 'client:' })).keys).toHaveLength(0)
  })

  it('returns a local retryable error when metadata cannot be fetched', async () => {
    const unavailableClientId = 'https://unavailable.example.com/oauth/client.json'
    server.use(http.get(unavailableClientId, () => new HttpResponse(null, { status: 502 })))

    const response = await exports.default.fetch(new Request(authorizeUrl(unavailableClientId)), {
      redirect: 'manual'
    })

    expect(response.status).toBe(503)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('retry-after')).toBe('30')
    expect(await response.text()).toContain('Client metadata is temporarily unavailable')
    expect((await env.OAUTH_KV.list({ prefix: 'grant:' })).keys).toHaveLength(0)
    expect((await env.OAUTH_KV.list({ prefix: 'client:' })).keys).toHaveLength(0)
  })

  it.each([
    'http://remote-client.example/callback',
    'ftp://remote-client.example/callback',
    'com.example.client:/callback'
  ])('rejects a non-HTTPS, non-loopback redirect URI locally: %s', async (redirectUri) => {
    server.use(
      http.get(CIMD_CLIENT_ID, () => HttpResponse.json(cimdMetadata(CIMD_CLIENT_ID, redirectUri)))
    )

    const response = await exports.default.fetch(
      new Request(authorizeUrl(CIMD_CLIENT_ID, redirectUri)),
      { redirect: 'manual' }
    )

    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toContain(
      'Redirect URI must use HTTPS or a local loopback address'
    )
    expect((await env.OAUTH_KV.list({ prefix: 'grant:' })).keys).toHaveLength(0)
  })

  it('never sends an authorization error to an unsafe redirect URI', async () => {
    const redirectUri = 'http://remote-client.example/callback'
    server.use(
      http.get(CIMD_CLIENT_ID, () => HttpResponse.json(cimdMetadata(CIMD_CLIENT_ID, redirectUri)))
    )

    const response = await exports.default.fetch(
      new Request(authorizeUrl(CIMD_CLIENT_ID, redirectUri, MCP_ORIGIN)),
      { redirect: 'manual' }
    )

    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
    expect(await response.text()).toContain('resource parameter must exactly match')
    expect((await env.OAUTH_KV.list({ prefix: 'grant:' })).keys).toHaveLength(0)
  })

  it('requires a fresh authorization when metadata fails during the callback', async () => {
    let metadataFetches = 0
    server.use(
      http.get(CIMD_CLIENT_ID, () => {
        metadataFetches++
        return metadataFetches <= 2
          ? HttpResponse.json(cimdMetadata())
          : new HttpResponse(null, { status: 502 })
      })
    )

    const authorization = await exports.default.fetch(new Request(authorizeUrl()))
    expect(authorization.status).toBe(200)
    const html = await authorization.text()
    const state = html.match(/name="state" value="([^"]+)"/)?.[1]
    const csrfToken = html.match(/name="csrf_token" value="([^"]+)"/)?.[1]
    expect(state && csrfToken).toBeTruthy()

    const approval = await exports.default.fetch(
      new Request(`${MCP_ORIGIN}/authorize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: cookiesFrom(authorization)
        },
        body: new URLSearchParams({
          state: state!,
          csrf_token: csrfToken!,
          scopes: 'user:read'
        }).toString(),
        redirect: 'manual'
      })
    )
    expect(approval.status).toBe(302)
    const upstreamState = new URL(approval.headers.get('location')!).searchParams.get('state')
    expect(upstreamState).toBeTruthy()

    useCloudflareAuthSuccess()
    const callback = await exports.default.fetch(
      new Request(
        `${MCP_ORIGIN}/oauth/callback?code=authcode&state=${encodeURIComponent(upstreamState!)}`,
        { headers: { Cookie: cookiesFrom(approval) }, redirect: 'manual' }
      )
    )

    expect(metadataFetches).toBe(3)
    expect(callback.status).toBe(500)
    expect(callback.headers.get('location')).toBeNull()
    expect(callback.headers.get('retry-after')).toBeNull()
    expect(await callback.text()).toContain('Restart authorization from your MCP client')
    expect((await env.OAUTH_KV.list({ prefix: 'oauth:state:' })).keys).toHaveLength(0)
    expect((await env.OAUTH_KV.list({ prefix: 'grant:' })).keys).toHaveLength(0)
    expect((await env.OAUTH_KV.list({ prefix: 'client:' })).keys).toHaveLength(0)
  })
})

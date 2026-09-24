import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import {
  generatePKCECodes,
  getAuthorizationURL,
  getAuthToken,
  refreshAuthToken
} from '../../src/auth/cloudflare-auth'
import { OAuthError } from '../../src/auth/workers-oauth-utils'
import { server } from '../setup/msw'

const OAUTH_DOMAIN = 'https://dash.cloudflare.com'
const OAUTH_TOKEN_URL = `${OAUTH_DOMAIN}/oauth2/token`

const refreshParams = {
  client_id: 'client-id',
  client_secret: 'client-secret',
  refresh_token: 'refresh-token',
  oauthDomain: OAUTH_DOMAIN
}

const tokenParams = {
  client_id: 'client-id',
  client_secret: 'client-secret',
  redirect_uri: 'https://mcp.example.com/oauth/callback',
  code: 'auth-code',
  code_verifier: 'verifier',
  oauthDomain: OAUTH_DOMAIN
}

const validToken = {
  access_token: 'access-token',
  expires_in: 3600,
  refresh_token: 'refresh-token',
  scope: 'read',
  token_type: 'bearer'
}

/** Run the REAL refreshAuthToken against an MSW-mocked upstream `response`. */
async function expectRefreshOAuthError(response: Response): Promise<OAuthError> {
  server.use(http.post(OAUTH_TOKEN_URL, () => response))

  try {
    await refreshAuthToken(refreshParams)
    throw new Error('Expected refreshAuthToken to throw')
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthError)
    return error as OAuthError
  }
}

/** Run the REAL getAuthToken against an MSW-mocked upstream `response`. */
async function expectAuthTokenOAuthError(response: Response): Promise<OAuthError> {
  server.use(http.post(OAUTH_TOKEN_URL, () => response))

  try {
    await getAuthToken(tokenParams)
    throw new Error('Expected getAuthToken to throw')
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthError)
    return error as OAuthError
  }
}

/** Recompute the expected S256 challenge for a verifier, base64url-encoded. */
async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  let binary = ''
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

describe('generatePKCECodes', () => {
  it('produces a url-safe verifier and a matching S256 challenge', async () => {
    const { codeVerifier, codeChallenge } = await generatePKCECodes()

    // Verifier is base64url (no +, /, or = padding).
    expect(codeVerifier).toMatch(/^[A-Za-z0-9\-._~]+$/)
    expect(codeVerifier.length).toBeGreaterThanOrEqual(43)
    // Challenge == base64url(SHA-256(verifier)).
    expect(codeChallenge).toBe(await s256Challenge(codeVerifier))
    expect(codeChallenge).not.toContain('=')
  })

  it('generates a fresh verifier each call', async () => {
    const a = await generatePKCECodes()
    const b = await generatePKCECodes()
    expect(a.codeVerifier).not.toBe(b.codeVerifier)
    expect(a.codeChallenge).not.toBe(b.codeChallenge)
  })
})

describe('getAuthorizationURL', () => {
  it('builds the Cloudflare /oauth2/auth URL with S256 PKCE and an opaque state token', async () => {
    const stateToken = 'b9f1c0de-1234-4abc-9def-0123456789ab'
    const { authUrl } = await getAuthorizationURL({
      client_id: 'client-id',
      redirect_uri: 'https://mcp.example.com/oauth/callback',
      stateToken,
      scopes: ['user:read', 'account:read'],
      codeChallenge: 'challenge-123',
      oauthDomain: OAUTH_DOMAIN
    })

    const url = new URL(authUrl)
    expect(url.origin + url.pathname).toBe(`${OAUTH_DOMAIN}/oauth2/auth`)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('https://mcp.example.com/oauth/callback')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-123')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('user:read account:read')
    // State is the opaque KV lookup token, passed through verbatim (RFC 6749 §10.12).
    expect(url.searchParams.get('state')).toBe(stateToken)
  })
})

describe('getAuthToken', () => {
  it('exchanges an authorization code and parses the token response', async () => {
    let form: FormData | undefined
    let authHeader: string | null = null
    server.use(
      http.post(OAUTH_TOKEN_URL, async ({ request }) => {
        form = await request.formData()
        authHeader = request.headers.get('Authorization')
        return HttpResponse.json(validToken)
      })
    )

    await expect(getAuthToken(tokenParams)).resolves.toEqual(validToken)

    // Sends grant_type=authorization_code with the PKCE verifier + Basic auth.
    expect(form?.get('grant_type')).toBe('authorization_code')
    expect(form?.get('code')).toBe('auth-code')
    expect(form?.get('code_verifier')).toBe('verifier')
    expect(authHeader).toBe(`Basic ${btoa('client-id:client-secret')}`)
  })

  it.each([
    // The RFC 6749 error field decides, not the HTTP status.
    [
      'invalid_grant (JSON)',
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
      'invalid_grant',
      400
    ],
    [
      'invalid_grant (form)',
      new Response('error=invalid_grant', { status: 400 }),
      'invalid_grant',
      400
    ],
    [
      'a 400 with no readable error',
      new Response('bad code', { status: 400 }),
      'invalid_grant',
      400
    ],
    // Our client credentials: a server problem, never invalid_client to the MCP client.
    [
      'invalid_client',
      Response.json({ error: 'invalid_client' }, { status: 401 }),
      'server_error',
      502
    ],
    ['a bare 401', new Response('bad creds', { status: 401 }), 'server_error', 502],
    [
      'unauthorized_client',
      Response.json({ error: 'unauthorized_client' }, { status: 400 }),
      'server_error',
      502
    ],
    // A bug on our side must not revoke users' grants.
    [
      'invalid_request',
      Response.json({ error: 'invalid_request' }, { status: 400 }),
      'server_error',
      502
    ],
    [
      'invalid_scope',
      Response.json({ error: 'invalid_scope' }, { status: 400 }),
      'server_error',
      502
    ],
    // Transient: retryable, the grant is kept.
    ['a 5xx', new Response('boom', { status: 503 }), 'temporarily_unavailable', 503],
    [
      'temporarily_unavailable',
      Response.json({ error: 'temporarily_unavailable' }, { status: 400 }),
      'temporarily_unavailable',
      503
    ]
  ])('maps %s', async (_label, response, code, statusCode) => {
    const error = await expectAuthTokenOAuthError(response)
    expect(error).toMatchObject({ code, statusCode })
  })

  it('throws (non-OAuth) when the token response shape is invalid', async () => {
    server.use(http.post(OAUTH_TOKEN_URL, () => HttpResponse.json({ not: 'a token' })))
    await expect(getAuthToken(tokenParams)).rejects.not.toBeInstanceOf(OAuthError)
  })
})

describe('refreshAuthToken', () => {
  it('preserves Retry-After from upstream OAuth 429 responses', async () => {
    const error = await expectRefreshOAuthError(
      new Response('rate limited', { status: 429, headers: { 'Retry-After': '42' } })
    )

    expect(error).toMatchObject({
      code: 'temporarily_unavailable',
      statusCode: 429,
      headers: { 'Retry-After': '42' }
    })
  })

  it('defaults Retry-After when upstream OAuth 429 responses omit it', async () => {
    const error = await expectRefreshOAuthError(new Response('rate limited', { status: 429 }))

    expect(error).toMatchObject({
      code: 'temporarily_unavailable',
      statusCode: 429,
      headers: { 'Retry-After': '30' }
    })
  })
})

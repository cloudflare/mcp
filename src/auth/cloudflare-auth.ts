import { z } from 'zod'

import { OAuthError } from './workers-oauth-utils'

/** The RFC 6749 §5.2 `error` code from a token-endpoint error body, JSON or form-encoded. */
function upstreamOAuthErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { error?: unknown }).error === 'string'
    ) {
      return (parsed as { error: string }).error
    }
  } catch {
    // Not JSON; try form encoding below.
  }
  return new URLSearchParams(body).get('error') ?? undefined
}

/**
 * Convert an upstream Cloudflare OAuth error into the OAuthError workers-oauth-provider acts on,
 * from the RFC 6749 `error` field rather than the HTTP status:
 * - retryable (429, 5xx, `temporarily_unavailable`) → `temporarily_unavailable`: the grant is kept;
 * - `invalid_grant` → `invalid_grant`: the provider revokes the grant and the client reauthorizes;
 * - anything else, including our own client credentials being rejected → `server_error`, never an
 *   `invalid_client` that would make the MCP client doubt its own registration.
 */
function throwUpstreamError(response: Response, body: string, context: string): never {
  const status = response.status
  const code = upstreamOAuthErrorCode(body)
  if (code === 'temporarily_unavailable' || status === 429 || status >= 500) {
    throw new OAuthError(
      'temporarily_unavailable',
      `${context}: upstream temporarily unavailable, try again later`,
      status === 429 ? 429 : 503,
      { 'Retry-After': response.headers.get('Retry-After') ?? '30' }
    )
  }
  // A 400 without a readable error keeps its historical meaning, so a dead refresh token still revokes.
  if (code === 'invalid_grant' || (code === undefined && status === 400)) {
    throw new OAuthError('invalid_grant', `${context}: invalid or expired grant`, 400)
  }
  throw new OAuthError(
    'server_error',
    `${context}: upstream rejected the request (${code ?? status})`,
    502
  )
}

const PKCE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
const CODE_VERIFIER_LENGTH = 96

function base64urlEncode(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export interface PKCECodes {
  codeChallenge: string
  codeVerifier: string
}

/**
 * Generate PKCE codes for OAuth authorization (S256 method)
 */
export async function generatePKCECodes(): Promise<PKCECodes> {
  const output = new Uint32Array(CODE_VERIFIER_LENGTH)
  crypto.getRandomValues(output)

  const codeVerifier = base64urlEncode(
    Array.from(output)
      .map((num) => PKCE_CHARSET[num % PKCE_CHARSET.length])
      .join('')
  )

  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))
  const hash = new Uint8Array(buffer)

  let binary = ''
  for (let i = 0; i < hash.byteLength; i++) {
    binary += String.fromCharCode(hash[i])
  }

  return { codeChallenge: base64urlEncode(binary), codeVerifier }
}

/**
 * Build the Cloudflare OAuth authorization URL
 */
export async function getAuthorizationURL(params: {
  client_id: string
  redirect_uri: string
  stateToken: string
  scopes: string[]
  codeChallenge: string
  oauthDomain: string
}): Promise<{ authUrl: string }> {
  const urlParams = new URLSearchParams({
    response_type: 'code',
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    state: params.stateToken,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    scope: params.scopes.join(' ')
  })

  return {
    authUrl: `${params.oauthDomain}/oauth2/auth?${urlParams.toString()}`
  }
}

const AuthorizationToken = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
  scope: z.string(),
  token_type: z.string()
})

export type AuthorizationToken = z.infer<typeof AuthorizationToken>

/**
 * Exchange authorization code for tokens
 */
export async function getAuthToken(params: {
  client_id: string
  client_secret: string
  redirect_uri: string
  code: string
  code_verifier: string
  oauthDomain: string
}): Promise<AuthorizationToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code: params.code,
    code_verifier: params.code_verifier
  })

  const resp = await fetch(`${params.oauthDomain}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${params.client_id}:${params.client_secret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  })

  if (!resp.ok) {
    const body = await resp.text()
    console.error(`Token exchange failed: ${resp.status}`, body)
    throwUpstreamError(resp, body, 'Token exchange failed')
  }

  return AuthorizationToken.parse(await resp.json())
}

/**
 * Refresh an expired access token
 */
export async function refreshAuthToken(params: {
  client_id: string
  client_secret: string
  refresh_token: string
  oauthDomain: string
}): Promise<AuthorizationToken> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: params.client_id,
    refresh_token: params.refresh_token
  })

  const resp = await fetch(`${params.oauthDomain}/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${params.client_id}:${params.client_secret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  })

  if (!resp.ok) {
    const body = await resp.text()
    console.error(`Token refresh failed: ${resp.status}`, body)
    throwUpstreamError(resp, body, 'Token refresh failed')
  }

  return AuthorizationToken.parse(await resp.json())
}

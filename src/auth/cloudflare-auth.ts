import { z } from 'zod'

import type { AuthRequest } from '@cloudflare/workers-oauth-provider'

import { OAuthError } from './workers-oauth-utils'

/**
 * Convert an upstream Cloudflare OAuth error response to an OAuthError.
 * 4xx: preserves the status code with a safe message.
 * 5xx: uses 502 Bad Gateway (we're proxying).
 */
function throwUpstreamError(status: number, context: string): never {
  if (status >= 500) {
    throw new OAuthError('server_error', `${context}: upstream service unavailable`, 502)
  }
  const codeMap: Record<number, [string, string]> = {
    400: ['invalid_grant', `${context}: invalid or expired grant`],
    401: ['invalid_client', `${context}: invalid client credentials`],
    403: ['unauthorized_client', `${context}: insufficient permissions`],
    429: ['temporarily_unavailable', `${context}: rate limited, try again later`]
  }
  const [code, desc] = codeMap[status] || ['invalid_grant', `${context}: request failed`]
  throw new OAuthError(code, desc, status)
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
  state: AuthRequest
  scopes: string[]
  codeChallenge: string
}): Promise<{ authUrl: string }> {
  const urlParams = new URLSearchParams({
    response_type: 'code',
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    state: btoa(JSON.stringify(params.state)),
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    scope: params.scopes.join(' ')
  })

  return {
    authUrl: `https://dash.cloudflare.com/oauth2/auth?${urlParams.toString()}`
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
}): Promise<AuthorizationToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code: params.code,
    code_verifier: params.code_verifier
  })

  const resp = await fetch('https://dash.cloudflare.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${params.client_id}:${params.client_secret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  })

  if (!resp.ok) {
    console.error(`Token exchange failed: ${resp.status}`, await resp.text())
    throwUpstreamError(resp.status, 'Token exchange failed')
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
}): Promise<AuthorizationToken> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: params.client_id,
    refresh_token: params.refresh_token
  })

  const resp = await fetch('https://dash.cloudflare.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${params.client_id}:${params.client_secret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  })

  if (!resp.ok) {
    console.error(`Token refresh failed: ${resp.status}`, await resp.text())
    throwUpstreamError(resp.status, 'Token refresh failed')
  }

  return AuthorizationToken.parse(await resp.json())
}

import { env as cloudflareEnv } from 'cloudflare:workers'

import { getUserAndAccounts } from './oauth-handler'
import { OAuthError } from './workers-oauth-utils'

import { AUTH_PROPS_VERSION, type AccountSchema, type AuthProps, type UserSchema } from './types'

const env = cloudflareEnv as Env
const API_TOKEN_IDENTITY_CACHE_TTL_SECONDS = 2_592_000

type ApiTokenIdentity = {
  user: UserSchema | null
  accounts: AccountSchema[]
  accountCount?: number
}

async function hashApiToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function getCachedApiTokenIdentity(token: string): Promise<ApiTokenIdentity> {
  const tokenHash = await hashApiToken(token)
  // v2 namespace: abandons pre-versioning entries that may hold a truncated
  // first page of accounts rather than the full (or count-only) list.
  const cacheKey = `api-token-identity:v2:${tokenHash}`
  try {
    const cached = await env.OAUTH_KV.get<ApiTokenIdentity>(cacheKey, 'json')
    if (cached) {
      return cached
    }
  } catch (error) {
    console.warn('api_token_identity_probe kv-cache read failed', error)
  }

  const identity = await getUserAndAccounts(token, 'api_token_identity_probe')

  try {
    await env.OAUTH_KV.put(cacheKey, JSON.stringify(identity), {
      expirationTtl: API_TOKEN_IDENTITY_CACHE_TTL_SECONDS
    })
  } catch (error) {
    console.warn('api_token_identity_probe kv-cache write failed', error)
  }

  return identity
}

/**
 * Check if the request contains a direct Cloudflare API token
 * (as opposed to an OAuth token issued by workers-oauth-provider)
 *
 * OAuth tokens have format: userId:grantId:secret (3 colon-separated parts)
 * Direct API tokens do NOT have this format
 */
export function isDirectApiToken(request: Request): boolean {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return false

  const token = authHeader.slice(7)
  const parts = token.split(':')

  // OAuth tokens have exactly 3 parts separated by colons
  return parts.length !== 3
}

/**
 * Extract bearer token from request
 */
export function extractBearerToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7)
}

/**
 * Handle requests with direct Cloudflare API tokens
 * Returns null if this is not an API token request (let OAuth handle it)
 */
export async function handleApiTokenRequest(
  request: Request,
  createMcpResponse: (props: AuthProps) => Promise<Response>
): Promise<Response | null> {
  if (!isDirectApiToken(request)) {
    return null
  }

  const token = extractBearerToken(request)
  if (!token) {
    return new Response(JSON.stringify({ error: 'Authorization header required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  try {
    const { user, accounts, accountCount } = await getCachedApiTokenIdentity(token)

    // Account-scoped token
    if (!user) {
      if (accounts.length === 0) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (accounts.length > 1) {
        return new Response(
          JSON.stringify({
            error: 'Token has access to multiple accounts - use account_id parameter'
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      }
      const props = buildAuthProps(token, null, accounts)
      return createMcpResponse(props)
    }

    // User token
    const props = buildAuthProps(token, user, accounts, accountCount)
    return createMcpResponse(props)
  } catch (err) {
    if (err instanceof OAuthError) {
      return err.toResponse()
    }
    return new Response(JSON.stringify({ error: 'Token verification failed' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

/**
 * Build AuthProps from verified token info
 */
export function buildAuthProps(
  token: string,
  user?: { id: string; email: string } | null,
  accounts?: Array<{ id: string; name: string }>,
  accountCount?: number
): AuthProps {
  if (user) {
    return {
      type: 'user_token',
      accessToken: token,
      user,
      accounts: accounts || [],
      accountCount,
      version: AUTH_PROPS_VERSION
    }
  }

  if (!accounts || accounts.length === 0) {
    throw new Error('Cannot build auth props: no user or account information')
  }

  return {
    type: 'account_token',
    accessToken: token,
    account: accounts[0]
  }
}

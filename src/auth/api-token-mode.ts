import { env as cloudflareEnv } from 'cloudflare:workers'

import { getUserAndAccounts } from './oauth-handler'
import { OAuthError } from './workers-oauth-utils'

import type { AccountSchema, AuthProps, UserSchema } from './types'

const env = cloudflareEnv as Env
const API_TOKEN_IDENTITY_CACHE_TTL_SECONDS = 2_592_000

type ApiTokenIdentity = {
  user: UserSchema | null
  accounts: AccountSchema[]
}

async function hashApiToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function getCachedApiTokenIdentity(token: string): Promise<ApiTokenIdentity> {
  const tokenHash = await hashApiToken(token)
  const cacheKey = `api-token-identity:${tokenHash}`
  const tokenHashPrefix = tokenHash.slice(0, 8)

  try {
    const cached = await env.OAUTH_KV.get<ApiTokenIdentity>(cacheKey, 'json')
    if (cached) {
      console.log(`api_token_identity_probe kv-cache status=HIT token_hash=${tokenHashPrefix}`)
      return cached
    }
  } catch (error) {
    console.warn('api_token_identity_probe kv-cache read failed', error)
  }

  console.log(`api_token_identity_probe kv-cache status=MISS token_hash=${tokenHashPrefix}`)
  const identity = await getUserAndAccounts(token, 'api_token_identity_probe')

  try {
    await env.OAUTH_KV.put(cacheKey, JSON.stringify(identity), {
      expirationTtl: API_TOKEN_IDENTITY_CACHE_TTL_SECONDS
    })
    console.log(`api_token_identity_probe kv-cache status=STORE token_hash=${tokenHashPrefix}`)
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
  createMcpResponse: (token: string, accountId?: string, props?: AuthProps) => Promise<Response>
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
    const { user, accounts } = await getCachedApiTokenIdentity(token)

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
      return createMcpResponse(token, accounts[0].id, props)
    }

    // User token
    const props = buildAuthProps(token, user, accounts)
    return createMcpResponse(token, undefined, props)
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
  accounts?: Array<{ id: string; name: string }>
): AuthProps {
  if (user) {
    return {
      type: 'user_token',
      accessToken: token,
      user,
      accounts: accounts || []
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

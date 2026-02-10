import { getUserAndAccounts } from './oauth-handler'

import type { AuthProps } from './types'

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
  createMcpResponse: (token: string, accountId?: string) => Promise<Response>
): Promise<Response | null> {
  if (!isDirectApiToken(request)) {
    return null
  }

  const token = extractBearerToken(request)
  if (!token) {
    return new Response(JSON.stringify({ error: 'Authorization header required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const { user, accounts } = await getUserAndAccounts(token)

    // Account-scoped token
    if (!user) {
      if (accounts.length === 0) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (accounts.length > 1) {
        return new Response(
          JSON.stringify({ error: 'Token has access to multiple accounts - use account_id parameter' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return createMcpResponse(token, accounts[0].id)
    }

    // User token
    return createMcpResponse(token)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token verification failed'
    return new Response(JSON.stringify({ error: message }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
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
      accounts: accounts || [],
    }
  }

  if (!accounts || accounts.length === 0) {
    throw new Error('Cannot build auth props: no user or account information')
  }

  return {
    type: 'account_token',
    accessToken: token,
    account: accounts[0],
  }
}

import { getUserAndAccounts } from './oauth-handler'

import type { AuthProps } from './types'

/**
 * Check if the request contains a Cloudflare Global API Key
 * (X-Auth-Email + X-Auth-Key headers)
 */
export function isGlobalApiKey(request: Request): boolean {
  return !!(request.headers.get('X-Auth-Email') && request.headers.get('X-Auth-Key'))
}

/**
 * Handle requests authenticated with Cloudflare Global API Key
 * Returns null if this is not a Global API Key request
 */
export async function handleGlobalApiKeyRequest(
  request: Request,
  createMcpResponse: (token: string, accountId?: string, props?: AuthProps) => Promise<Response>
): Promise<Response | null> {
  if (!isGlobalApiKey(request)) {
    return null
  }

  const email = request.headers.get('X-Auth-Email')!
  const apiKey = request.headers.get('X-Auth-Key')!

  try {
    const { user, accounts } = await getUserAndAccounts({
      type: 'global_api_key',
      email,
      apiKey
    })

    if (!user) {
      return new Response(JSON.stringify({ error: 'Failed to verify Global API Key' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const props: AuthProps = {
      type: 'global_api_key',
      email,
      apiKey,
      user,
      accounts
    }

    return createMcpResponse('', undefined, props)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Global API Key verification failed'
    return new Response(JSON.stringify({ error: message }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    })
  }
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
    const { user, accounts } = await getUserAndAccounts(token)

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
    const message = err instanceof Error ? err.message : 'Token verification failed'
    return new Response(JSON.stringify({ error: message }), {
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

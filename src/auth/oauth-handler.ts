import { env as cloudflareEnv } from 'cloudflare:workers'
import { Hono } from 'hono'
import { z } from 'zod'

import {
  generatePKCECodes,
  getAuthorizationURL,
  getAuthToken,
  refreshAuthToken
} from './cloudflare-auth'
import {
  ALL_SCOPES,
  SCOPE_TEMPLATES,
  DEFAULT_TEMPLATE,
  MAX_SCOPES,
  REQUIRED_SCOPES
} from './scopes'
import { UserSchema, AccountsSchema, type AuthProps, type AccountSchema } from './types'
import {
  clientIdAlreadyApproved,
  createOAuthState,
  bindStateToSession,
  generateCSRFProtection,
  parseRedirectApproval,
  renderApprovalDialog,
  renderErrorPage,
  validateOAuthState,
  OAuthError
} from './workers-oauth-utils'
import { fetchWithRetry } from '../utils/fetch-retry'

import type {
  AuthRequest,
  OAuthHelpers,
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult
} from '@cloudflare/workers-oauth-provider'

interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers
}

const env = cloudflareEnv as AuthEnv
const REFRESH_GUARD_PREFIX = 'oauth:refresh-guard'
const REFRESH_IN_FLIGHT_TTL_SECONDS = 60
const REFRESH_FAILURE_TTL_SECONDS = 3600
const refreshInFlight = new Map<string, Promise<TokenExchangeCallbackResult | undefined>>()

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function refreshGuardKeys(refreshTokenHash: string): { inFlight: string; failure: string } {
  return {
    inFlight: `${REFRESH_GUARD_PREFIX}:${refreshTokenHash}:in-flight`,
    failure: `${REFRESH_GUARD_PREFIX}:${refreshTokenHash}:failure`
  }
}

function isTerminalRefreshError(error: unknown): error is OAuthError {
  return (
    error instanceof OAuthError &&
    ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(error.code)
  )
}

async function getCachedRefreshFailure(
  kv: KVNamespace,
  failureKey: string
): Promise<{ code?: string; description?: string } | null> {
  try {
    const failure = await kv.get(failureKey, { type: 'json' })
    if (!failure || typeof failure !== 'object') return null
    return failure as { code?: string; description?: string }
  } catch (error) {
    console.warn('Refresh guard: failed to read cached refresh failure', error)
    return null
  }
}

async function isRefreshInFlight(kv: KVNamespace, inFlightKey: string): Promise<boolean> {
  try {
    return Boolean(await kv.get(inFlightKey))
  } catch (error) {
    console.warn('Refresh guard: failed to read in-flight marker', error)
    return false
  }
}

async function markRefreshInFlight(kv: KVNamespace, inFlightKey: string): Promise<void> {
  try {
    await kv.put(inFlightKey, JSON.stringify({ startedAt: Date.now() }), {
      expirationTtl: REFRESH_IN_FLIGHT_TTL_SECONDS
    })
  } catch (error) {
    console.warn('Refresh guard: failed to write in-flight marker', error)
  }
}

async function cacheRefreshFailure(
  kv: KVNamespace,
  failureKey: string,
  error: OAuthError
): Promise<void> {
  try {
    await kv.put(
      failureKey,
      JSON.stringify({
        code: error.code,
        description: 'Token refresh failed; reauthorization is required',
        failedAt: Date.now()
      }),
      { expirationTtl: REFRESH_FAILURE_TTL_SECONDS }
    )
  } catch (cacheError) {
    console.warn('Refresh guard: failed to cache terminal refresh failure', cacheError)
  }
}

async function clearRefreshInFlight(kv: KVNamespace, inFlightKey: string): Promise<void> {
  try {
    await kv.delete(inFlightKey)
  } catch (error) {
    console.warn('Refresh guard: failed to clear in-flight marker', error)
  }
}

export async function guardRefreshTokenExchange(
  kv: KVNamespace,
  refreshToken: string,
  refresh: () => Promise<TokenExchangeCallbackResult | undefined>
): Promise<TokenExchangeCallbackResult | undefined> {
  const refreshTokenHash = await sha256Hex(refreshToken)
  const keys = refreshGuardKeys(refreshTokenHash)
  const existingRefresh = refreshInFlight.get(refreshTokenHash)
  if (existingRefresh) return existingRefresh

  const refreshPromise = (async () => {
    try {
      const cachedFailure = await getCachedRefreshFailure(kv, keys.failure)
      if (cachedFailure) {
        throw new OAuthError(
          cachedFailure.code || 'invalid_grant',
          cachedFailure.description || 'Token refresh recently failed; reauthorization is required',
          400
        )
      }

      if (await isRefreshInFlight(kv, keys.inFlight)) {
        throw new OAuthError(
          'temporarily_unavailable',
          'Token refresh is already in progress; retry shortly',
          429,
          { 'Retry-After': '30' }
        )
      }

      await markRefreshInFlight(kv, keys.inFlight)

      try {
        return await refresh()
      } catch (error) {
        if (isTerminalRefreshError(error)) {
          await cacheRefreshFailure(kv, keys.failure, error)
        }
        throw error
      } finally {
        await clearRefreshInFlight(kv, keys.inFlight)
      }
    } finally {
      refreshInFlight.delete(refreshTokenHash)
    }
  })()

  refreshInFlight.set(refreshTokenHash, refreshPromise)
  return refreshPromise
}

function getRetryAfterHeader(...responses: Response[]): Record<string, string> {
  return {
    'Retry-After':
      responses.find((response) => response.status === 429)?.headers.get('Retry-After') ?? '30'
  }
}

function throwCombinedCloudflareApiError(userResp: Response, accountsResp: Response): never {
  const statuses = [userResp.status, accountsResp.status]

  if (statuses.some((status) => status >= 500)) {
    throw new OAuthError('server_error', 'Cloudflare API is temporarily unavailable', 502)
  }

  if (statuses.includes(429)) {
    throw new OAuthError('temporarily_unavailable', 'Rate limited, try again later', 429, {
      ...getRetryAfterHeader(userResp, accountsResp)
    })
  }

  if (statuses.includes(401)) {
    throw new OAuthError('invalid_token', 'Access token is invalid or expired', 401)
  }

  if (statuses.includes(403)) {
    throw new OAuthError('insufficient_scope', 'Insufficient permissions', 403)
  }

  throw new OAuthError('invalid_token', 'Failed to verify token', userResp.status)
}

async function fetchCloudflareProbes(
  accessToken: string,
  caller = 'oauth_callback_identity_probe'
): Promise<[Response, Response]> {
  const headers = { Authorization: `Bearer ${accessToken}` }

  try {
    return await Promise.all([
      fetchWithRetry(`${env.CLOUDFLARE_API_BASE}/user`, { headers }, { caller }),
      fetchWithRetry(`${env.CLOUDFLARE_API_BASE}/accounts`, { headers }, { caller })
    ])
  } catch (error) {
    console.error('Cloudflare API request failed', error)
    throw new OAuthError('server_error', 'Cloudflare API is temporarily unavailable', 502)
  }
}

/**
 * Fetch user and accounts from Cloudflare API
 */
export async function getUserAndAccounts(
  accessToken: string,
  caller = 'oauth_callback_identity_probe'
): Promise<{
  user: UserSchema | null
  accounts: AccountSchema[]
}> {
  const [userResp, accountsResp] = await fetchCloudflareProbes(accessToken, caller)

  // Check for upstream errors before parsing
  if (!userResp.ok && !accountsResp.ok) {
    console.error(`Cloudflare API error: user=${userResp.status}, accounts=${accountsResp.status}`)
    throwCombinedCloudflareApiError(userResp, accountsResp)
  }

  // Parse user from response
  let user: UserSchema | null = null
  if (userResp.ok) {
    try {
      const json = (await userResp.json()) as { success?: boolean; result?: unknown }
      if (json.success && json.result) {
        const parsed = UserSchema.safeParse(json.result)
        if (parsed.success) {
          user = parsed.data
        } else {
          console.error('Cloudflare API /user payload did not match expected shape', parsed.error)
        }
      }
    } catch (error) {
      console.error('Cloudflare API /user response is not valid JSON', error)
    }
  }

  // Parse accounts from response
  let accounts: AccountSchema[] = []
  if (accountsResp.ok) {
    try {
      const json = (await accountsResp.json()) as { success?: boolean; result?: unknown }
      if (json.success && json.result) {
        const parsed = AccountsSchema.safeParse(json.result)
        if (parsed.success) {
          accounts = parsed.data
        } else {
          console.error(
            'Cloudflare API /accounts payload did not match expected shape',
            parsed.error
          )
        }
      }
    } catch (error) {
      console.error('Cloudflare API /accounts response is not valid JSON', error)
    }
  }

  if (user) {
    return { user, accounts }
  }

  // Account-scoped token - user will be null
  if (accounts.length > 0) {
    return { user: null, accounts }
  }

  throw new OAuthError(
    'invalid_token',
    'Failed to verify token: no user or account information',
    401
  )
}

/**
 * Handle token refresh for workers-oauth-provider.
 *
 * Throws the local `OAuthError` (which extends the provider's exported
 * `OAuthError`) for intentional refresh failures so workers-oauth-provider
 * converts them into structured `/token` responses.
 */
export async function handleTokenExchangeCallback(
  options: TokenExchangeCallbackOptions,
  clientId: string,
  clientSecret: string
): Promise<TokenExchangeCallbackResult | undefined> {
  if (options.grantType !== 'refresh_token') {
    return undefined
  }

  const AuthPropsSchema = z.discriminatedUnion('type', [
    z.object({
      type: z.literal('account_token'),
      accessToken: z.string(),
      account: z.object({ id: z.string(), name: z.string() })
    }),
    z.object({
      type: z.literal('user_token'),
      accessToken: z.string(),
      user: z.object({ id: z.string(), email: z.string() }),
      accounts: z.array(z.object({ id: z.string(), name: z.string() })),
      refreshToken: z.string().optional()
    })
  ])

  const props = AuthPropsSchema.parse(options.props)

  if (props.type !== 'user_token' || !props.refreshToken) {
    return undefined
  }

  const upstreamRefreshToken = props.refreshToken

  return guardRefreshTokenExchange(env.OAUTH_KV, upstreamRefreshToken, async () => {
    const { access_token, refresh_token, expires_in } = await refreshAuthToken({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: upstreamRefreshToken,
      oauthDomain: env.CLOUDFLARE_OAUTH_DOMAIN
    })

    return {
      newProps: {
        ...props,
        accessToken: access_token,
        refreshToken: refresh_token
      } satisfies AuthProps,
      accessTokenTTL: expires_in
    }
  })
}

/**
 * Redirect to Cloudflare OAuth with selected scopes
 */
async function redirectToCloudflare(
  requestUrl: string,
  oauthReqInfo: AuthRequest,
  stateToken: string,
  codeChallenge: string,
  scopes: string[],
  additionalHeaders: Record<string, string> = {}
): Promise<Response> {
  const stateWithToken: AuthRequest = {
    ...oauthReqInfo,
    state: stateToken
  }

  const { authUrl } = await getAuthorizationURL({
    client_id: env.CLOUDFLARE_CLIENT_ID,
    redirect_uri: new URL('/oauth/callback', requestUrl).href,
    state: stateWithToken,
    scopes,
    codeChallenge,
    oauthDomain: env.CLOUDFLARE_OAUTH_DOMAIN
  })

  return new Response(null, {
    status: 302,
    headers: {
      ...additionalHeaders,
      Location: authUrl
    }
  })
}

/**
 * Create OAuth route handlers using patterns from workers-oauth-provider
 */
export function createAuthHandlers() {
  const app = new Hono()

  // GET /authorize - Show consent dialog or redirect if previously approved
  app.get('/authorize', async (c) => {
    try {
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw)
      // Use default template scopes initially
      const defaultScopes = [...SCOPE_TEMPLATES[DEFAULT_TEMPLATE].scopes]
      oauthReqInfo.scope = defaultScopes

      if (!oauthReqInfo.clientId) {
        return new OAuthError('invalid_request', 'Missing client_id').toHtmlResponse()
      }

      // Check if client was previously approved - skip consent if so
      if (
        await clientIdAlreadyApproved(
          c.req.raw,
          oauthReqInfo.clientId,
          env.MCP_COOKIE_ENCRYPTION_KEY
        )
      ) {
        const { codeChallenge, codeVerifier } = await generatePKCECodes()
        const stateToken = await createOAuthState(oauthReqInfo, env.OAUTH_KV, codeVerifier)
        const { setCookie: sessionCookie } = await bindStateToSession(stateToken)

        return redirectToCloudflare(
          c.req.url,
          oauthReqInfo,
          stateToken,
          codeChallenge,
          defaultScopes,
          {
            'Set-Cookie': sessionCookie
          }
        )
      }

      // Client not approved - show consent dialog with scope selection
      const { token: csrfToken, setCookie: csrfCookie } = generateCSRFProtection()

      return renderApprovalDialog(c.req.raw, {
        client: await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId),
        server: {
          name: 'Cloudflare API MCP',
          logo: 'https://www.cloudflare.com/favicon.ico',
          description: 'Access the Cloudflare API through the Model Context Protocol.'
        },
        state: { oauthReqInfo },
        csrfToken,
        setCookie: csrfCookie,
        scopeTemplates: SCOPE_TEMPLATES,
        allScopes: ALL_SCOPES,
        defaultTemplate: DEFAULT_TEMPLATE,
        maxScopes: MAX_SCOPES,
        requiredScopes: REQUIRED_SCOPES
      })
    } catch (e) {
      if (e instanceof OAuthError) return e.toHtmlResponse()
      const errorId = crypto.randomUUID()
      console.error(`Authorize error [${errorId}]:`, e)
      return renderErrorPage(
        'Server Error',
        'An unexpected error occurred. Please try again.',
        `Error ID: ${errorId}`,
        500
      )
    }
  })

  // POST /authorize - Handle consent form submission
  app.post('/authorize', async (c) => {
    try {
      const { state, headers, selectedScopes } = await parseRedirectApproval(
        c.req.raw,
        env.MCP_COOKIE_ENCRYPTION_KEY
      )

      if (!state.oauthReqInfo) {
        return new OAuthError('invalid_request', 'Missing OAuth request info').toHtmlResponse()
      }

      const oauthReqInfo = state.oauthReqInfo as AuthRequest

      // Checkboxes are the source of truth — accept whatever the frontend sends
      const scopesToRequest = (
        selectedScopes && selectedScopes.length > 0 ? selectedScopes : []
      ).slice(0, MAX_SCOPES)

      // Update oauthReqInfo with selected scopes
      oauthReqInfo.scope = scopesToRequest

      // Create OAuth state and bind to session
      const { codeChallenge, codeVerifier } = await generatePKCECodes()
      const stateToken = await createOAuthState(oauthReqInfo, env.OAUTH_KV, codeVerifier)
      const { setCookie: sessionCookie } = await bindStateToSession(stateToken)

      const redirectResponse = await redirectToCloudflare(
        c.req.url,
        oauthReqInfo,
        stateToken,
        codeChallenge,
        scopesToRequest
      )

      // Add both cookies
      if (headers['Set-Cookie']) {
        redirectResponse.headers.append('Set-Cookie', headers['Set-Cookie'])
      }
      redirectResponse.headers.append('Set-Cookie', sessionCookie)

      return redirectResponse
    } catch (e) {
      if (e instanceof OAuthError) return e.toHtmlResponse()
      const errorId = crypto.randomUUID()
      console.error(`Authorize POST error [${errorId}]:`, e)
      return renderErrorPage(
        'Server Error',
        'An unexpected error occurred. Please try again.',
        `Error ID: ${errorId}`,
        500
      )
    }
  })

  // GET /oauth/callback - Handle Cloudflare OAuth redirect
  app.get('/oauth/callback', async (c) => {
    try {
      const code = c.req.query('code')
      if (!code) {
        return new OAuthError('invalid_request', 'Missing code').toHtmlResponse()
      }

      // Validate state using dual validation (KV + session cookie)
      const { oauthReqInfo, codeVerifier, clearCookie } = await validateOAuthState(
        c.req.raw,
        env.OAUTH_KV
      )

      if (!oauthReqInfo.clientId) {
        return new OAuthError('invalid_request', 'Invalid OAuth request info').toHtmlResponse()
      }

      // Exchange code for tokens and ensure client is registered
      const [{ access_token, refresh_token }] = await Promise.all([
        getAuthToken({
          client_id: env.CLOUDFLARE_CLIENT_ID,
          client_secret: env.CLOUDFLARE_CLIENT_SECRET,
          redirect_uri: new URL('/oauth/callback', c.req.url).href,
          code,
          code_verifier: codeVerifier,
          oauthDomain: env.CLOUDFLARE_OAUTH_DOMAIN
        }),
        env.OAUTH_PROVIDER.createClient({
          clientId: oauthReqInfo.clientId,
          tokenEndpointAuthMethod: 'none'
        })
      ])

      // Fetch user and accounts
      const { user, accounts } = await getUserAndAccounts(access_token)

      // Account-scoped tokens (user: null) are only supported via API token mode
      // (see api-token-mode.ts). The OAuth flow always requires a user identity.
      if (!user) {
        return new OAuthError(
          'server_error',
          'Failed to fetch user information from Cloudflare'
        ).toHtmlResponse()
      }

      // Complete authorization
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: user.id,
        metadata: { label: user.email },
        scope: oauthReqInfo.scope,
        props: {
          type: 'user_token',
          user,
          accounts,
          accessToken: access_token,
          refreshToken: refresh_token
        } satisfies AuthProps
      })

      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectTo,
          'Set-Cookie': clearCookie
        }
      })
    } catch (e) {
      if (e instanceof OAuthError) return e.toHtmlResponse()
      const errorId = crypto.randomUUID()
      console.error(`Callback error [${errorId}]:`, e)
      return renderErrorPage(
        'Server Error',
        'An unexpected error occurred during authorization.',
        `Error ID: ${errorId}`,
        500
      )
    }
  })

  return app
}

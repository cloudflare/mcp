import { env as cloudflareEnv } from 'cloudflare:workers'
import { Hono } from 'hono'

import {
  generatePKCECodes,
  getAuthorizationURL,
  getAuthToken,
  refreshAuthToken
} from './cloudflare-auth'
import { DEFAULT_TEMPLATE, REQUIRED_SCOPES, SCOPE_DEFINITIONS, SCOPE_TEMPLATES } from './scopes'
import { AuthProps as AuthPropsSchema, AUTH_PROPS_VERSION, type AuthProps } from './types'
import {
  createOAuthState,
  bindStateToSession,
  generateCSRFProtection,
  parseRedirectApproval,
  renderApprovalDialog,
  renderErrorPage,
  validateOAuthState,
  OAuthError
} from './workers-oauth-utils'
import { getCloudflareOAuthUser } from './cloudflare-identity'
import { MetricsTracker, AuthUser } from '../metrics'
import { SERVER_INFO } from '../constants'

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
const ALLOWED_SCOPES = new Set(Object.keys(SCOPE_DEFINITIONS))
const REFRESH_GUARD_PREFIX = 'oauth:refresh-guard'

const metrics = new MetricsTracker(env.MCP_METRICS, SERVER_INFO)

/** Format an unknown thrown value into a stable `auth_user` error message. */
function authErrorMessage(prefix: string, e: unknown): string {
  let message: string
  if (e instanceof Error) {
    message = `${e.name}: ${e.message}`
  } else if (typeof e === 'string') {
    message = e
  } else {
    message = 'Unknown error'
  }
  return `${prefix}: ${message}`
}
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

/**
 * Context needed to kill the downstream grant + emit telemetry when an upstream
 * refresh fails. Optional so the guard stays usable in isolation (tests).
 */
export interface RefreshGuardContext {
  /** Downstream OAuth user id (from the token-exchange callback options). */
  userId?: string
  /** Downstream OAuth client id (from the token-exchange callback options). */
  clientId?: string
  /** Exact downstream grant being refreshed. */
  grantId?: string
  /**
   * Lazily builds OAuth helpers (via `getOAuthApi`). Only invoked on a terminal
   * `invalid_grant` so we don't construct the provider on every refresh.
   */
  getHelpers?: () => OAuthHelpers
}

type RefreshFailureKind = 'upstream_terminal' | 'cached_replay' | 'in_flight_collision'

/**
 * Structured, greppable telemetry for refresh failures. Logged as a single JSON
 * line prefixed with `[refresh-telemetry]` so it can be counted in Workers Logs.
 *
 * `kind` distinguishes the cases you want to measure:
 *  - `upstream_terminal`: upstream /oauth2/token actually returned a terminal
 *    error this request (the *first-time* failure). `grantsRevoked` tells you
 *    whether we killed the grant.
 *  - `cached_replay`: a retry that short-circuited on the cached failure within
 *    REFRESH_FAILURE_TTL_SECONDS (a *repeat*, never hit upstream).
 *  - `in_flight_collision`: another isolate was mid-refresh.
 */
function logRefreshTelemetry(event: {
  kind: RefreshFailureKind
  code: string
  refreshTokenHash: string
  userId?: string
  clientId?: string
  grantsRevoked?: number
}): void {
  console.error(`[refresh-telemetry] ${JSON.stringify({ ...event, at: Date.now() })}`)
}

async function getCachedRefreshFailure(
  kv: KVNamespace,
  failureKey: string
): Promise<{
  code?: string
  description?: string
  statusCode?: number
  headers?: Record<string, string>
} | null> {
  try {
    const failure = await kv.get(failureKey, { type: 'json' })
    if (!failure || typeof failure !== 'object') return null
    return failure as {
      code?: string
      description?: string
      statusCode?: number
      headers?: Record<string, string>
    }
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
        // Preserve the upstream status + headers so a cached replay returns the
        // same response as the original failure (e.g. 401 invalid_client, or a
        // 429 with Retry-After) instead of a flat 400 with no headers.
        statusCode: error.statusCode,
        headers: error.headers,
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
  refresh: () => Promise<TokenExchangeCallbackResult | undefined>,
  context: RefreshGuardContext = {}
): Promise<TokenExchangeCallbackResult | undefined> {
  const refreshTokenHash = await sha256Hex(refreshToken)
  const keys = refreshGuardKeys(refreshTokenHash)
  const existingRefresh = refreshInFlight.get(refreshTokenHash)
  if (existingRefresh) return existingRefresh

  const refreshPromise = (async () => {
    try {
      const cachedFailure = await getCachedRefreshFailure(kv, keys.failure)
      if (cachedFailure) {
        const code = cachedFailure.code || 'invalid_grant'
        // A retry of an already-failed token within the cache TTL. The grant was
        // already killed on the first failure; this never reaches upstream.
        logRefreshTelemetry({
          kind: 'cached_replay',
          code,
          refreshTokenHash,
          userId: context.userId,
          clientId: context.clientId
        })
        throw new OAuthError(
          code,
          cachedFailure.description || 'Token refresh recently failed; reauthorization is required',
          cachedFailure.statusCode ?? 400,
          cachedFailure.headers ?? {}
        )
      }

      if (await isRefreshInFlight(kv, keys.inFlight)) {
        logRefreshTelemetry({
          kind: 'in_flight_collision',
          code: 'temporarily_unavailable',
          refreshTokenHash,
          userId: context.userId,
          clientId: context.clientId
        })
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

          // The core fix: when upstream rejects the stored refresh token with
          // invalid_grant it is permanently dead, so kill the downstream grant
          // and force re-auth instead of letting the client retry forever.
          // Other terminal codes (invalid_client/unauthorized_client) are
          // server-side credential problems that revoking wouldn't fix.
          let grantsRevoked = 0
          if (
            error.code === 'invalid_grant' &&
            context.userId &&
            context.grantId &&
            context.getHelpers
          ) {
            try {
              await context.getHelpers().revokeGrant(context.grantId, context.userId)
              grantsRevoked = 1
            } catch (revokeError) {
              console.error(
                'Refresh guard: failed to revoke grant after invalid_grant',
                revokeError
              )
            }
          }

          logRefreshTelemetry({
            kind: 'upstream_terminal',
            code: error.code,
            refreshTokenHash,
            userId: context.userId,
            clientId: context.clientId,
            grantsRevoked
          })
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
  clientSecret: string,
  /**
   * Lazily builds OAuth helpers so we can revoke the downstream grant when the
   * upstream refresh token is rejected with `invalid_grant`. Wired from
   * `index.ts` (the only place with the full provider options needed by
   * `getOAuthApi`). Optional so existing callers/tests keep working.
   */
  getHelpers?: () => OAuthHelpers
): Promise<TokenExchangeCallbackResult | undefined> {
  if (options.grantType !== 'refresh_token') {
    return undefined
  }

  const props = AuthPropsSchema.parse(options.props)

  if (props.type !== 'user_token' || !props.refreshToken) {
    return undefined
  }

  const upstreamRefreshToken = props.refreshToken

  return guardRefreshTokenExchange(
    env.OAUTH_KV,
    upstreamRefreshToken,
    async () => {
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
    },
    {
      userId: options.userId,
      clientId: options.clientId,
      grantId: options.grantId,
      getHelpers
    }
  )
}

/**
 * Redirect to Cloudflare OAuth with selected scopes
 */
async function redirectToCloudflare(
  requestUrl: string,
  stateToken: string,
  codeChallenge: string,
  scopes: string[],
  additionalHeaders: Record<string, string> = {}
): Promise<Response> {
  const { authUrl } = await getAuthorizationURL({
    client_id: env.CLOUDFLARE_CLIENT_ID,
    redirect_uri: new URL('/oauth/callback', requestUrl).href,
    stateToken,
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

  // GET /authorize - Show the requested scopes in the consent dialog
  app.get('/authorize', async (c) => {
    try {
      const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw)
      const defaultScopes = [...SCOPE_TEMPLATES[DEFAULT_TEMPLATE].scopes]
      const requestedScopes = oauthReqInfo.scope ?? []
      const unknownScopes = requestedScopes.filter((scope) => !ALLOWED_SCOPES.has(scope))
      if (unknownScopes.length > 0) {
        return new OAuthError(
          'invalid_scope',
          `Unknown OAuth scope: ${unknownScopes.join(', ')}`
        ).toHtmlResponse()
      }
      const scopesToRequest = Array.from(
        new Set([
          ...(requestedScopes.length > 0 ? requestedScopes : defaultScopes),
          ...REQUIRED_SCOPES
        ])
      )
      oauthReqInfo.scope = scopesToRequest

      if (!oauthReqInfo.clientId) {
        return new OAuthError('invalid_request', 'Missing client_id').toHtmlResponse()
      }

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
        scopeDefinitions: SCOPE_DEFINITIONS,
        defaultTemplate: DEFAULT_TEMPLATE,
        requiredScopes: REQUIRED_SCOPES,
        initialScopes: scopesToRequest
      })
    } catch (e) {
      metrics.logEvent(new AuthUser({ errorMessage: authErrorMessage('Authorize Error', e) }))
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
      const { state, selectedScopes } = await parseRedirectApproval(c.req.raw)

      if (!state.oauthReqInfo) {
        return new OAuthError('invalid_request', 'Missing OAuth request info').toHtmlResponse()
      }

      const oauthReqInfo = state.oauthReqInfo as AuthRequest

      // Drop stale custom-template entries and always restore required bootstrap scopes.
      const scopesToRequest = Array.from(
        new Set([...(selectedScopes ?? []), ...REQUIRED_SCOPES])
      ).filter((scope) => ALLOWED_SCOPES.has(scope))

      // Update oauthReqInfo with selected scopes
      oauthReqInfo.scope = scopesToRequest

      // Create OAuth state and bind to session
      const { codeChallenge, codeVerifier } = await generatePKCECodes()
      const stateToken = await createOAuthState(oauthReqInfo, env.OAUTH_KV, codeVerifier)
      const { setCookie: sessionCookie } = await bindStateToSession(stateToken)

      const redirectResponse = await redirectToCloudflare(
        c.req.url,
        stateToken,
        codeChallenge,
        scopesToRequest
      )

      redirectResponse.headers.append('Set-Cookie', sessionCookie)

      return redirectResponse
    } catch (e) {
      metrics.logEvent(new AuthUser({ errorMessage: authErrorMessage('Authorize POST Error', e) }))
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

      const identity = await getCloudflareOAuthUser(access_token)

      // Complete authorization
      const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
        request: oauthReqInfo,
        userId: identity.user.id,
        metadata: { label: identity.user.email },
        scope: oauthReqInfo.scope,
        props: {
          type: 'user_token',
          user: identity.user,
          accounts: identity.accounts,
          accountCount: identity.accountCount,
          version: AUTH_PROPS_VERSION,
          accessToken: access_token,
          refreshToken: refresh_token
        } satisfies AuthProps
      })

      metrics.logEvent(new AuthUser({ userId: identity.user.id }))

      return new Response(null, {
        status: 302,
        headers: {
          Location: redirectTo,
          'Set-Cookie': clearCookie
        }
      })
    } catch (e) {
      metrics.logEvent(new AuthUser({ errorMessage: authErrorMessage('Callback Error', e) }))
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

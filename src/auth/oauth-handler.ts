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
import { withRefreshAdmission } from './refresh-admission-gate'
import { MetricsTracker, AuthUser } from '../metrics'
import { SERVER_INFO } from '../constants'

import {
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
  type OAuthHelpers,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult
} from '@cloudflare/workers-oauth-provider'

interface AuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers
}

const env = cloudflareEnv as AuthEnv
const ALLOWED_SCOPES = new Set(Object.keys(SCOPE_DEFINITIONS))
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

/**
 * Refresh the upstream Cloudflare grant when workers-oauth-provider refreshes
 * its downstream access token. The per-grant admission gate rejects competing
 * provider exchanges so they cannot independently rotate downstream tokens.
 */
export async function handleTokenExchangeCallback(
  options: TokenExchangeCallbackOptions,
  clientId: string,
  clientSecret: string,
  getHelpers?: () => OAuthHelpers
): Promise<TokenExchangeCallbackResult | undefined> {
  if (options.grantType !== 'refresh_token') return undefined

  const props = AuthPropsSchema.parse(options.props)
  if (props.type !== 'user_token' || !props.refreshToken) return undefined
  if (!options.userId || !options.grantId) {
    throw new Error('Refresh token exchange is missing its grant identity')
  }
  const grant = { userId: options.userId, grantId: options.grantId }
  const upstreamRefreshToken = props.refreshToken

  try {
    return await withRefreshAdmission(env.OAUTH_KV, grant, async () => {
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
  } catch (error) {
    // A genuine upstream invalid_grant is permanent. Revoke only this exact
    // downstream grant so the client reauthorizes instead of retrying forever.
    if (
      error instanceof OAuthError &&
      error.code === 'invalid_grant' &&
      options.userId &&
      options.grantId &&
      getHelpers
    ) {
      try {
        await getHelpers().revokeGrant(options.grantId, options.userId)
      } catch (revokeError) {
        console.error('Failed to revoke grant after upstream invalid_grant', revokeError)
      }
    }
    throw error
  }
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
      let oauthReqInfo: AuthRequest
      try {
        oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw)
      } catch (error) {
        if (error instanceof AuthorizationError) {
          if (!error.redirectUri) {
            return new OAuthError(error.code, error.description).toHtmlResponse()
          }
          const redirect = new URL(error.redirectUri)
          redirect.searchParams.set('error', error.code)
          redirect.searchParams.set('error_description', error.description)
          if (error.state) redirect.searchParams.set('state', error.state)
          if (error.issuer) redirect.searchParams.set('iss', error.issuer)
          return new Response(null, {
            status: 302,
            headers: { Location: redirect.href, 'Cache-Control': 'no-store' }
          })
        }
        if (error instanceof CimdFetchError) {
          return new OAuthError(
            'temporarily_unavailable',
            'Client metadata is temporarily unavailable. Please try again.',
            503,
            { 'Retry-After': '30' }
          ).toHtmlResponse()
        }
        throw error
      }
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

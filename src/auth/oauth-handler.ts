import { env as cloudflareEnv } from 'cloudflare:workers'
import { Hono } from 'hono'

import {
  generatePKCECodes,
  getAuthorizationURL,
  getAuthToken,
  refreshAuthToken
} from './cloudflare-auth'
import {
  ALL_SCOPES,
  DEFAULT_TEMPLATE,
  REQUIRED_SCOPES,
  SCOPE_DEFINITIONS,
  SCOPE_TEMPLATES
} from './scopes'
import { AuthProps as AuthPropsSchema, AUTH_PROPS_VERSION, type AuthProps } from './types'
import {
  isAllowedOAuthRedirectUri,
  parseRedirectApproval,
  renderApprovalDialog,
  renderErrorPage,
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
const ALLOWED_SCOPES = new Set<string>(ALL_SCOPES)
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
 *
 * A genuine upstream invalid_grant is permanent; refreshAuthToken throws it as
 * OAuthError('invalid_grant') and workers-oauth-provider revokes this grant,
 * so the client reauthorizes instead of retrying forever.
 */
export async function handleTokenExchangeCallback(
  options: TokenExchangeCallbackOptions,
  clientId: string,
  clientSecret: string
): Promise<TokenExchangeCallbackResult | undefined> {
  if (options.grantType !== 'refresh_token') return undefined

  const props = AuthPropsSchema.parse(options.props)
  if (props.type !== 'user_token' || !props.refreshToken) return undefined
  if (!options.userId || !options.grantId) {
    throw new Error('Refresh token exchange is missing its grant identity')
  }
  const grant = { userId: options.userId, grantId: options.grantId }
  const upstreamRefreshToken = props.refreshToken

  // Awaited so the gate's synchronous rejection of competing refreshes is handled here.
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

function cimdUnavailableResponse(): Response {
  return new OAuthError(
    'temporarily_unavailable',
    'Client metadata is temporarily unavailable. Please try again.',
    503,
    { 'Retry-After': '30' }
  ).toHtmlResponse()
}

function cimdCallbackFailureResponse(): Response {
  return new OAuthError(
    'server_error',
    'Client metadata could not be verified after sign-in. Restart authorization from your MCP client.',
    500
  ).toHtmlResponse()
}

function invalidRedirectUriResponse(): Response {
  return new OAuthError(
    'invalid_request',
    'Redirect URI must use HTTPS or a local loopback address'
  ).toHtmlResponse()
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
          if (!error.redirectUri || !isAllowedOAuthRedirectUri(error.redirectUri)) {
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
          return cimdUnavailableResponse()
        }
        throw error
      }
      if (!isAllowedOAuthRedirectUri(oauthReqInfo.redirectUri)) {
        return invalidRedirectUriResponse()
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
      // Clients request the resource's required scopes (its 401 names them), which says nothing
      // about what else they want: only a request beyond them overrides the default template.
      const requiredScopes: readonly string[] = REQUIRED_SCOPES
      const choseScopes = requestedScopes.some((scope) => !requiredScopes.includes(scope))
      const scopesToRequest = Array.from(
        new Set([...(choseScopes ? requestedScopes : defaultScopes), ...REQUIRED_SCOPES])
      )
      oauthReqInfo.scope = scopesToRequest

      // The request stays server-side; the dialog posts back only this browser-bound handle.
      const consent = await env.OAUTH_PROVIDER.beginConsent(oauthReqInfo)

      return renderApprovalDialog(c.req.raw, {
        client: await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId),
        redirectUri: oauthReqInfo.redirectUri,
        server: {
          name: 'Cloudflare API MCP',
          logo: 'https://www.cloudflare.com/favicon.ico',
          description: 'Access the Cloudflare API through the Model Context Protocol.'
        },
        handle: consent.handle,
        headers: consent.headers,
        scopeTemplates: SCOPE_TEMPLATES,
        scopeDefinitions: SCOPE_DEFINITIONS,
        defaultTemplate: DEFAULT_TEMPLATE,
        requiredScopes: REQUIRED_SCOPES,
        initialScopes: scopesToRequest
      })
    } catch (e) {
      if (e instanceof CimdFetchError) return cimdUnavailableResponse()
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
      const { handle, decision, selectedScopes } = await parseRedirectApproval(c.req.raw)

      if (decision === 'deny') {
        // Back to the MCP client with access_denied, its state and iss.
        const denied = await env.OAUTH_PROVIDER.denyConsent(c.req.raw, handle)
        return new Response(null, { status: 302, headers: denied.headers })
      }

      // Drop stale custom-template entries and always restore required bootstrap scopes.
      const scopesToRequest = Array.from(
        new Set([...(selectedScopes ?? []), ...REQUIRED_SCOPES])
      ).filter((scope) => ALLOWED_SCOPES.has(scope))

      // The request comes back from storage, not from the form.
      const approved = await env.OAUTH_PROVIDER.approveConsent(c.req.raw, handle, {
        scope: scopesToRequest
      })
      if (!isAllowedOAuthRedirectUri(approved.request.redirectUri)) {
        return invalidRedirectUriResponse()
      }

      // Create the upstream state only now, after consent, bound to this browser.
      const { codeChallenge, codeVerifier } = await generatePKCECodes()
      const upstream = await env.OAUTH_PROVIDER.beginUpstream(approved.request, {
        data: { codeVerifier },
        headers: approved.headers
      })

      const redirectResponse = await redirectToCloudflare(
        c.req.url,
        upstream.state,
        codeChallenge,
        scopesToRequest
      )
      for (const cookie of upstream.headers.getSetCookie()) {
        redirectResponse.headers.append('Set-Cookie', cookie)
      }

      return redirectResponse
    } catch (e) {
      metrics.logEvent(new AuthUser({ errorMessage: authErrorMessage('Authorize POST Error', e) }))
      // Consent/upstream transaction expired, used, or opened in another browser: render locally.
      if (e instanceof AuthorizationError)
        return new OAuthError(e.code, e.description).toHtmlResponse()
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
      // Recover the approved request (single use, bound to this browser by its cookie).
      const {
        request: oauthReqInfo,
        data: { codeVerifier },
        headers
      } = await env.OAUTH_PROVIDER.finishUpstream<{ codeVerifier: string }>(c.req.raw)

      if (!isAllowedOAuthRedirectUri(oauthReqInfo.redirectUri)) {
        const response = invalidRedirectUriResponse()
        for (const cookie of headers.getSetCookie()) response.headers.append('Set-Cookie', cookie)
        return response
      }

      // The user declined (or sign-in failed) at Cloudflare: tell the MCP client.
      if (c.req.query('error')) {
        const redirect = new URL(oauthReqInfo.redirectUri)
        redirect.searchParams.set('error', 'access_denied')
        if (oauthReqInfo.state) redirect.searchParams.set('state', oauthReqInfo.state)
        if (oauthReqInfo.issuer) redirect.searchParams.set('iss', oauthReqInfo.issuer)
        headers.set('Location', redirect.href)
        return new Response(null, { status: 302, headers })
      }

      const code = c.req.query('code')
      if (!code) {
        return new OAuthError('invalid_request', 'Missing code').toHtmlResponse()
      }

      if (!oauthReqInfo.clientId) {
        return new OAuthError('invalid_request', 'Invalid OAuth request info').toHtmlResponse()
      }

      const { access_token, refresh_token } = await getAuthToken({
        client_id: env.CLOUDFLARE_CLIENT_ID,
        client_secret: env.CLOUDFLARE_CLIENT_SECRET,
        redirect_uri: new URL('/oauth/callback', c.req.url).href,
        code,
        code_verifier: codeVerifier,
        oauthDomain: env.CLOUDFLARE_OAUTH_DOMAIN
      })

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

      if (!isAllowedOAuthRedirectUri(redirectTo)) {
        throw new OAuthError('server_error', 'Authorization produced an unsafe redirect URI')
      }

      metrics.logEvent(new AuthUser({ userId: identity.user.id }))

      headers.set('Location', redirectTo)
      return new Response(null, { status: 302, headers })
    } catch (e) {
      if (e instanceof CimdFetchError) return cimdCallbackFailureResponse()
      metrics.logEvent(new AuthUser({ errorMessage: authErrorMessage('Callback Error', e) }))
      // Consent/upstream transaction expired, used, or opened in another browser: render locally.
      if (e instanceof AuthorizationError)
        return new OAuthError(e.code, e.description).toHtmlResponse()
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

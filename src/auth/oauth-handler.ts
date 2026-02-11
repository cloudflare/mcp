import { env as cloudflareEnv } from 'cloudflare:workers'
import { Hono } from 'hono'
import { z } from 'zod'

import {
  generatePKCECodes,
  getAuthorizationURL,
  getAuthToken,
  refreshAuthToken
} from './cloudflare-auth'
import { ALL_SCOPES, SCOPE_TEMPLATES, DEFAULT_TEMPLATE } from './scopes'
import { UserSchema, AccountsSchema, type AuthProps } from './types'
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

/** Cloudflare API response shape */
interface CloudflareApiResponse<T> {
  success: boolean
  result?: T
  errors?: Array<{ code: number; message: string }>
}

/**
 * Fetch user and accounts from Cloudflare API
 */
export async function getUserAndAccounts(accessToken: string): Promise<{
  user: { id: string; email: string } | null
  accounts: Array<{ id: string; name: string }>
}> {
  const headers = { Authorization: `Bearer ${accessToken}` }

  const [userResp, accountsResp] = await Promise.all([
    fetch(`${env.CLOUDFLARE_API_BASE}/user`, { headers }),
    fetch(`${env.CLOUDFLARE_API_BASE}/accounts`, { headers })
  ])

  const userData = (await userResp.json()) as CloudflareApiResponse<{ id: string; email: string }>
  const accountsData = (await accountsResp.json()) as CloudflareApiResponse<
    Array<{ id: string; name: string }>
  >

  // Parse accounts (always try)
  const accounts =
    accountsData.success && accountsData.result ? AccountsSchema.parse(accountsData.result) : []

  // User token - parse user
  if (userData.success && userData.result) {
    return {
      user: UserSchema.parse(userData.result),
      accounts
    }
  }

  // Account-scoped token - user will be null
  if (accounts.length > 0) {
    return { user: null, accounts }
  }

  throw new Error('Failed to fetch user or accounts')
}

/**
 * Handle token refresh for workers-oauth-provider
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

  const { access_token, refresh_token, expires_in } = await refreshAuthToken({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: props.refreshToken
  })

  return {
    newProps: {
      ...props,
      accessToken: access_token,
      refreshToken: refresh_token
    } satisfies AuthProps,
    accessTokenTTL: expires_in
  }
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
    codeChallenge
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
        defaultTemplate: DEFAULT_TEMPLATE
      })
    } catch (e) {
      if (e instanceof OAuthError) return e.toHtmlResponse()
      console.error('Authorize error:', e)
      return renderErrorPage(
        'Server Error',
        'An unexpected error occurred. Please try again.',
        e instanceof Error ? e.message : undefined
      )
    }
  })

  // POST /authorize - Handle consent form submission
  app.post('/authorize', async (c) => {
    try {
      const { state, headers, selectedScopes, selectedTemplate } = await parseRedirectApproval(
        c.req.raw,
        env.MCP_COOKIE_ENCRYPTION_KEY
      )

      if (!state.oauthReqInfo) {
        return new OAuthError('invalid_request', 'Missing OAuth request info').toHtmlResponse()
      }

      const oauthReqInfo = state.oauthReqInfo as AuthRequest

      // Determine which scopes to request
      let scopesToRequest: string[]
      if (selectedScopes && selectedScopes.length > 0) {
        // User customized individual scopes
        scopesToRequest = selectedScopes
      } else if (selectedTemplate && selectedTemplate in SCOPE_TEMPLATES) {
        // User selected a template
        scopesToRequest = [
          ...SCOPE_TEMPLATES[selectedTemplate as keyof typeof SCOPE_TEMPLATES].scopes
        ]
      } else {
        // Fallback to default template
        scopesToRequest = [...SCOPE_TEMPLATES[DEFAULT_TEMPLATE].scopes]
      }

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
      console.error('Authorize POST error:', e)
      return renderErrorPage(
        'Server Error',
        'An unexpected error occurred. Please try again.',
        e instanceof Error ? e.message : undefined
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
          code_verifier: codeVerifier
        }),
        env.OAUTH_PROVIDER.createClient({
          clientId: oauthReqInfo.clientId,
          tokenEndpointAuthMethod: 'none'
        })
      ])

      // Fetch user and accounts
      const { user, accounts } = await getUserAndAccounts(access_token)

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
      console.error('Callback error:', e)
      return renderErrorPage(
        'Server Error',
        'An unexpected error occurred during authorization.',
        e instanceof Error ? e.message : undefined
      )
    }
  })

  return app
}

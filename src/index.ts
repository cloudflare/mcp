import OAuthProvider, {
  getOAuthApi,
  type OAuthProviderOptions
} from '@cloudflare/workers-oauth-provider'
import { createAuthHandlers, handleTokenExchangeCallback } from './auth/oauth-handler'
import { isDirectApiToken, handleApiTokenRequest } from './auth/api-token-mode'
import {
  MCP_ROUTE,
  handleAuthenticatedMcpRequest,
  handleMcpPreflight,
  oauthMcpHandler,
  rejectInvalidMcpRequest
} from './mcp-handler'
import { processSpec, extractProducts } from './spec-processor'
import { buildNonCodemodeTools, type OperationInfo } from './openapi'

// GlobalOutbound lives with the execute tool (its only caller); wrangler
// resolves the GLOBAL_OUTBOUND worker-loader entrypoint from this entry module,
// so it must be re-exported here.
export { GlobalOutbound } from './tools/execute'

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const isMcpRoute = url.pathname === MCP_ROUTE
    if (url.pathname.startsWith(MCP_ROUTE) && !isMcpRoute) {
      return new Response('Not Found', { status: 404 })
    }
    if (isMcpRoute) {
      // Validate Host and browser Origin before authentication so an invalid
      // request cannot spend a bearer token on Cloudflare API identity probes.
      const rejected = rejectInvalidMcpRequest(request)
      if (rejected) return rejected
      if (request.method === 'OPTIONS') return handleMcpPreflight(request)
    }

    // Check for direct API token first (like GitHub MCP's PAT support)
    if (isMcpRoute && isDirectApiToken(request)) {
      const response = await handleApiTokenRequest(request, (props) =>
        handleAuthenticatedMcpRequest(request, props)
      )
      if (response) return response
    }

    // OAuth mode - handle via workers-oauth-provider
    const oauthOptions: OAuthProviderOptions<Env> = {
      apiHandlers: {
        [MCP_ROUTE]: oauthMcpHandler
      },
      // @ts-ignore - Hono apps are compatible with ExportedHandler at runtime
      defaultHandler: createAuthHandlers(),
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      tokenExchangeCallback: (options) =>
        handleTokenExchangeCallback(
          options,
          env.CLOUDFLARE_CLIENT_ID,
          env.CLOUDFLARE_CLIENT_SECRET,
          // Lazily build helpers (only invoked on terminal invalid_grant) so we
          // can revoke the dead grant. env.OAUTH_PROVIDER is NOT injected during
          // the token endpoint, so we must construct the API explicitly here.
          () => getOAuthApi(oauthOptions, env)
        ),
      resourceMetadata: {
        resource_name: 'Cloudflare API MCP Server'
      },
      accessTokenTTL: 3600,
      refreshTokenTTL: 2592000, // 30 days
      // TODO: Remove after 2026-05-01 — all pre-0.4.0 grants will have expired by then
      resourceMatchOriginOnly: true
    }
    return new OAuthProvider(oauthOptions).fetch(request, env, ctx)
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    console.log('Fetching OpenAPI spec from:', env.OPENAPI_SPEC_URL)

    const response = await fetch(env.OPENAPI_SPEC_URL)
    if (!response.ok) {
      throw new Error(`Failed to fetch OpenAPI spec: ${response.status}`)
    }

    const rawSpec = (await response.json()) as Record<string, unknown>
    console.log('Processing spec, resolving $refs...')

    const processed = processSpec(rawSpec)
    const specJson = JSON.stringify(processed)

    const products = extractProducts(rawSpec)
    const productsJson = JSON.stringify(products)
    const paths = (processed as { paths: Record<string, Record<string, OperationInfo>> }).paths
    const nonCodemodeToolsJson = JSON.stringify(buildNonCodemodeTools(paths))

    console.log(`Writing spec to R2 (${(specJson.length / 1024).toFixed(0)} KB)`)
    await Promise.all([
      env.SPEC_BUCKET.put('spec.json', specJson, {
        httpMetadata: { contentType: 'application/json' }
      }),
      env.SPEC_BUCKET.put('products.json', productsJson, {
        httpMetadata: { contentType: 'application/json' }
      }),
      env.SPEC_BUCKET.put('non-codemode-tools.json', nonCodemodeToolsJson, {
        httpMetadata: { contentType: 'application/json' }
      })
    ])

    console.log(`Spec updated successfully (${products.length} products)`)
  }
}

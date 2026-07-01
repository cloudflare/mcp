import OAuthProvider, { getOAuthApi } from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { createServer } from './server'
import { createAuthHandlers, handleTokenExchangeCallback } from './auth/oauth-handler'
import { isDirectApiToken, handleApiTokenRequest } from './auth/api-token-mode'
import { processSpec, extractProducts } from './spec-processor'
import { buildNonCodemodeTools, type OperationInfo } from './openapi'
import type { AuthProps } from './auth/types'

// GlobalOutbound lives with the execute tool (its only caller); wrangler
// resolves the GLOBAL_OUTBOUND worker-loader entrypoint from this entry module,
// so it must be re-exported here.
export { GlobalOutbound } from './tools/execute'

type McpContext = {
  Bindings: Env
}

/**
 * Create an MCP response for the authenticated session described by `props`.
 */
async function createMcpResponse(
  request: Request,
  ctx: ExecutionContext,
  props: AuthProps
): Promise<Response> {
  const url = new URL(request.url)
  const codemode = url.searchParams.get('codemode') !== 'false'
  const server = await createServer(props, codemode)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    retryInterval: 1000
  })

  await server.connect(transport)
  const response = await transport.handleRequest(request)
  ctx.waitUntil(transport.close())

  return response
}

/**
 * Create MCP API handler using Hono
 */
function createMcpHandler() {
  const app = new Hono<McpContext>()

  app.post('/mcp', async (c) => {
    // Props are passed via ExecutionContext by workers-oauth-provider
    const ctx = c.executionCtx as ExecutionContext & { props?: AuthProps }
    const props = ctx.props
    if (!props || !props.accessToken) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    return createMcpResponse(c.req.raw, ctx, props)
  })

  return app
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Check for direct API token first (like GitHub MCP's PAT support)
    if (isDirectApiToken(request)) {
      const response = await handleApiTokenRequest(request, (props) =>
        createMcpResponse(request, ctx, props)
      )
      if (response) return response
    }

    // OAuth mode - handle via workers-oauth-provider
    const oauthOptions: ConstructorParameters<typeof OAuthProvider>[0] = {
      apiHandlers: {
        // @ts-ignore - Hono apps are compatible with ExportedHandler at runtime
        '/mcp': createMcpHandler()
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

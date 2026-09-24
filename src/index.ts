import OAuthProvider from '@cloudflare/workers-oauth-provider'
import { env as workerEnv } from 'cloudflare:workers'
import { createAuthHandlers, handleTokenExchangeCallback } from './auth/oauth-handler'
import { resolveExternalToken } from './auth/api-token-mode'
import {
  MCP_ROUTE,
  handleMcpPreflight,
  oauthMcpHandler,
  rejectInvalidMcpRequest
} from './mcp-handler'
import { processSpec, extractProducts } from './spec-processor'
import { buildNonCodemodeTools, type OperationInfo } from './openapi'

const OPENAI_APPS_CHALLENGE_PATH = '/.well-known/openai-apps-challenge'
const OPENAI_APPS_CHALLENGE_TOKEN = 'dQ0VUqjILNASTqFl73Rc8kt2ttMpEMmpqEZWsRhlpfc'

// GlobalOutbound lives with the execute tool (its only caller); wrangler
// resolves the GLOBAL_OUTBOUND worker-loader entrypoint from this entry module,
// so it must be re-exported here.
export { GlobalOutbound } from './tools/execute'

// Built once per isolate: constructing the provider validates its whole configuration, which used to
// run on every request. The module-scope `env` from cloudflare:workers carries the same bindings and
// secrets the request's env does.
// workers-oauth-provider resolves its own access tokens first, then delegates
// direct Cloudflare API/OAuth credentials to resolveExternalToken.
const oauthProvider = new OAuthProvider<Env>({
  apiHandlers: {
    [MCP_ROUTE]: oauthMcpHandler
  },
  defaultHandler: createAuthHandlers(),
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  clientIdMetadataDocumentEnabled: true,
  resolveExternalToken,
  // An upstream invalid_grant thrown here revokes the grant (workers-oauth-provider 1.x).
  tokenExchangeCallback: (options) =>
    handleTokenExchangeCallback(
      options,
      workerEnv.CLOUDFLARE_CLIENT_ID,
      workerEnv.CLOUDFLARE_CLIENT_SECRET
    ),
  resourceMetadata: {
    resource: workerEnv.MCP_RESOURCE,
    resource_name: 'Cloudflare API MCP Server'
  },
  accessTokenTTL: 3600,
  refreshTokenTTL: 2592000 // 30 days
})

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === OPENAI_APPS_CHALLENGE_PATH) {
      return new Response(OPENAI_APPS_CHALLENGE_TOKEN, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      })
    }

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

    return oauthProvider.fetch(request, env, ctx)
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

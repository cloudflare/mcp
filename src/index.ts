import OAuthProvider from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createServer } from './server'
import { createAuthHandlers, handleTokenExchangeCallback } from './auth/oauth-handler'
import { isDirectApiToken, handleApiTokenRequest } from './auth/api-token-mode'
import { processSpec, extractProducts } from './spec-processor'
import type { AuthProps } from './auth/types'

const ALLOWED_HOSTNAMES = ['api.cloudflare.com']

/**
 * Global outbound fetch handler that restricts dynamically-loaded workers
 * to only make requests to Cloudflare API domains.
 */
export class GlobalOutbound extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (!ALLOWED_HOSTNAMES.includes(url.hostname)) {
      return new Response(`Forbidden: requests to ${url.hostname} are not allowed`, { status: 403 })
    }
    return fetch(request)
  }
}

type McpContext = {
  Bindings: Env
}

/**
 * Create MCP response for a given token and optional account ID
 */
async function createMcpResponse(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  token: string,
  accountId?: string,
  props?: AuthProps
): Promise<Response> {
  const server = await createServer(env, token, accountId, props)
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
    const accountId = props.type === 'account_token' ? props.account.id : undefined
    return createMcpResponse(c.req.raw, c.env, ctx, props.accessToken, accountId, props)
  })

  return app
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Check for direct API token first (like GitHub MCP's PAT support)
    if (isDirectApiToken(request)) {
      const response = await handleApiTokenRequest(request, (token, accountId, props) =>
        createMcpResponse(request, env, ctx, token, accountId, props)
      )
      if (response) return response
    }

    // OAuth mode - handle via workers-oauth-provider
    return new OAuthProvider({
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
          env.CLOUDFLARE_CLIENT_SECRET
        ),
      accessTokenTTL: 3600
    }).fetch(request, env, ctx)
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

    console.log(`Writing spec to R2 (${(specJson.length / 1024).toFixed(0)} KB)`)
    await Promise.all([
      env.SPEC_BUCKET.put('spec.json', specJson, {
        httpMetadata: { contentType: 'application/json' }
      }),
      env.SPEC_BUCKET.put('products.json', productsJson, {
        httpMetadata: { contentType: 'application/json' }
      })
    ])

    console.log(`Spec updated successfully (${products.length} products)`)
  }
}

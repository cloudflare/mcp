import OAuthProvider from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createServer } from './server'
import { createAuthHandlers, handleTokenExchangeCallback } from './auth/oauth-handler'
import { isDirectApiToken, handleApiTokenRequest } from './auth/api-token-mode'
import type { AuthProps } from './auth/types'

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
  accountId?: string
): Promise<Response> {
  const server = createServer(env, token, accountId)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
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
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const accountId = props.type === 'account_token' ? props.account.id : undefined
    return createMcpResponse(c.req.raw, c.env, ctx, props.accessToken, accountId)
  })

  return app
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Check for direct API token first (like GitHub MCP's PAT support)
    if (isDirectApiToken(request)) {
      const response = await handleApiTokenRequest(request, (token, accountId) =>
        createMcpResponse(request, env, ctx, token, accountId)
      )
      if (response) return response
    }

    // OAuth mode - handle via workers-oauth-provider
    return new OAuthProvider({
      apiHandlers: {
        // @ts-ignore - Hono apps are compatible with ExportedHandler at runtime
        '/mcp': createMcpHandler(),
      },
      // @ts-ignore - Hono apps are compatible with ExportedHandler at runtime
      defaultHandler: createAuthHandlers(),
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      tokenExchangeCallback: (options) =>
        handleTokenExchangeCallback(options, env.CLOUDFLARE_CLIENT_ID, env.CLOUDFLARE_CLIENT_SECRET),
      accessTokenTTL: 3600,
    }).fetch(request, env, ctx)
  },
}

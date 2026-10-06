import { insufficientScope } from '@cloudflare/workers-oauth-provider'
import type { OAuthResourceAuth, OAuthResourceContext } from '@cloudflare/workers-oauth-provider'
import { ScopeController, verifiedScopeContext } from './auth/scope-context'
import { getOperationPolicies } from './isolate-cache'
import { env } from 'cloudflare:workers'
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse
} from '@modelcontextprotocol/server'
import { createServer, type ServerOptions } from './server'
import { AuthProps as AuthPropsSchema, type AuthProps } from './auth/types'

export const MCP_ROUTE = '/mcp'

const ALLOWED_MCP_HOSTNAMES = [
  ...localhostAllowedHostnames(),
  'staging.mcp.cloudflare.com',
  'mcp.cloudflare.com'
]

const ALLOWED_MCP_ORIGIN_HOSTNAMES = [
  ...localhostAllowedOrigins(),
  'staging.mcp.cloudflare.com',
  'mcp.cloudflare.com'
]

/**
 * Read the server options from the MCP URL query string. Each option stays on
 * unless the client passes exactly `false`, e.g. `/mcp?codemode=false`.
 */
function serverOptionsFromUrl(url: string): ServerOptions {
  const params = new URL(url).searchParams
  return {
    codemode: params.get('codemode') !== 'false',
    truncateToolResult: params.get('truncateToolResult') !== 'false',
    toolAuthChallenge: params.get('oauthChallenge') === 'tool'
  }
}

function createAuthenticatedHandler(props: AuthProps, controller: ScopeController) {
  return createMcpHandler(({ requestInfo }) => {
    if (!requestInfo) {
      throw new Error('The Cloudflare MCP server requires an HTTP request')
    }

    return createServer(props, serverOptionsFromUrl(requestInfo.url), controller)
  })
}

const SUBSCRIPTIONS_LISTEN = 'subscriptions/listen'

// Handler options are intentionally omitted. The SDK defaults to:
// - stateless 2025 compatibility, with a fresh server and no protocol session
// - automatic JSON/SSE response shaping (ordinary requests here remain JSON)

/** Validate the deployment boundary before authentication or MCP dispatch. */
export function rejectInvalidMcpRequest(request: Request): Response | undefined {
  return (
    hostHeaderValidationResponse(request, ALLOWED_MCP_HOSTNAMES) ??
    originValidationResponse(request, ALLOWED_MCP_ORIGIN_HOSTNAMES)
  )
}

function corsHeaders(request: Request): Headers | undefined {
  const origin = request.headers.get('Origin')
  if (!origin) return undefined

  const requestedHeaders = request.headers.get('Access-Control-Request-Headers')
  const headers = new Headers({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      requestedHeaders ??
      'Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Expose-Headers': 'WWW-Authenticate, Retry-After',
    Vary: 'Origin'
  })
  return headers
}

function withCors(response: Response, request: Request): Response {
  const cors = corsHeaders(request)
  if (!cors) return response

  const headers = new Headers(response.headers)
  for (const [name, value] of cors) headers.set(name, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

/** Serve an allowed browser preflight without invoking authentication or a server factory. */
export function handleMcpPreflight(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) })
}

/** Serve one authenticated MCP exchange with a fresh SDK v2 server instance. */
export async function handleAuthenticatedMcpRequest(
  request: Request,
  rawProps: unknown,
  auth?: OAuthResourceAuth
): Promise<Response> {
  if (new URL(request.url).pathname !== MCP_ROUTE) {
    return new Response('Not Found', { status: 404 })
  }

  const rejected = rejectInvalidMcpRequest(request)
  if (rejected) return rejected

  const props = AuthPropsSchema.parse(rawProps)
  const controller = new ScopeController(
    verifiedScopeContext(auth, env.MCP_RESOURCE),
    getOperationPolicies,
    env.CLOUDFLARE_API_BASE,
    auth
      ? (scopes) =>
          insufficientScope(auth, scopes, 'Additional permission is required for this operation')
      : undefined
  )
  const handler = createAuthenticatedHandler(props, controller)
  let response: Response
  if (request.method === 'POST' && controller.context && (await isLegacyRequest(request))) {
    // The default legacy path opens SSE before its tool has finished. OAuth
    // exchanges use a single JSON result so a safe challenge precedes headers.
    const server = await createServer(props, serverOptionsFromUrl(request.url), controller)
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    })
    try {
      await server.connect(transport)
      response = await transport.handleRequest(request)
    } finally {
      await transport.close()
      await server.close()
    }
  } else {
    response = await handler.fetch(request)
  }

  // This server publishes no change notifications and keeps no long-lived
  // request state. The SDK only serves subscriptions/listen after checking that
  // the Mcp-Method header matches the body. It acknowledges the subscription
  // with every unsupported notification type left out. Closing this
  // per-request handler then ends the subscription gracefully, as the spec
  // describes: it writes a `complete` result and closes the stream, so no
  // isolate stays pinned. Clients get an empty subscription instead of an
  // error.
  if (request.headers.get('Mcp-Method') === SUBSCRIPTIONS_LISTEN) {
    await handler.close()
  }

  const challenge = controller.challenge(auth)
  if (
    !serverOptionsFromUrl(request.url).toolAuthChallenge &&
    challenge &&
    response.headers.get('Content-Type')?.includes('application/json')
  ) {
    await response.body?.cancel()
    await handler.close()
    return withCors(challenge, request)
  }
  if (challenge && serverOptionsFromUrl(request.url).toolAuthChallenge) {
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store')
    response = new Response(response.body, { status: response.status, headers })
  }
  return withCors(response, request)
}

/** Provider 1.2.1 supplies verified authorization separately from application props. */
export const oauthMcpHandler = {
  fetch(
    request: Request,
    _env: Env,
    ctx: ExecutionContext & Partial<Pick<OAuthResourceContext<unknown>, 'auth'>>
  ) {
    return handleAuthenticatedMcpRequest(request, ctx.props, ctx.auth)
  }
}

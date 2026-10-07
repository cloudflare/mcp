import type { OAuthResourceAuth, OAuthResourceContext } from '@cloudflare/workers-oauth-provider'
import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse
} from '@modelcontextprotocol/server'
import type { McpServer } from '@modelcontextprotocol/server'
import { createServer, type ServerOptions } from './server'
import { connectionFromAuth, type Connection } from './api-permissions'
import { ScopeChallenge } from './scope-challenge'
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
    truncateToolResult: params.get('truncateToolResult') !== 'false'
  }
}

/**
 * Where a step-up challenge goes: the spec's HTTP `403` (default), or the tool
 * result's `_meta["mcp/www_authenticate"]`, which ChatGPT reads, with
 * `/mcp?scopeChallenge=tool`.
 */
function challengeDeliveryFromUrl(url: string): 'http' | 'tool' {
  return new URL(url).searchParams.get('scopeChallenge') === 'tool' ? 'tool' : 'http'
}

function createAuthenticatedHandler(
  props: AuthProps,
  connection: Connection,
  scopeChallenge: ScopeChallenge
) {
  return createMcpHandler(({ requestInfo, era }) => {
    if (!requestInfo) {
      throw new Error('The Cloudflare MCP server requires an HTTP request')
    }

    return createServer(
      props,
      { ...serverOptionsFromUrl(requestInfo.url), era },
      connection,
      scopeChallenge
    )
  })
}

// Handler options are intentionally omitted. The SDK defaults to:
// - stateless 2025 compatibility, with a fresh server and no protocol session
// - automatic JSON/SSE response shaping (ordinary requests here remain JSON)

/**
 * Serve a 2025-era POST as one JSON response, not the SSE stream the SDK's
 * stateless fallback opens before the tool runs. The status is then still
 * open when a tool asks for a step-up, so a `403` can replace the result.
 */
async function serveLegacyAsJson(request: Request, server: McpServer): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  })
  try {
    await server.connect(transport)
    return await transport.handleRequest(request)
  } finally {
    await transport.close()
    await server.close()
  }
}

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
    'Access-Control-Expose-Headers': 'WWW-Authenticate',
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

/**
 * Serve one authenticated MCP exchange with a fresh SDK v2 server instance.
 *
 * @param request - The MCP HTTP request.
 * @param rawProps - `ctx.props` from workers-oauth-provider.
 * @param auth - `ctx.auth` from workers-oauth-provider: the verified token's scopes.
 */
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
  const connection = connectionFromAuth(auth)
  // Only tokens this server issued can step up; their tools can ask for a scope.
  const scopeChallenge = new ScopeChallenge(connection.kind === 'oauth' ? auth : undefined)

  const response =
    connection.kind === 'oauth' && request.method === 'POST' && (await isLegacyRequest(request))
      ? await serveLegacyAsJson(
          request,
          await createServer(props, serverOptionsFromUrl(request.url), connection, scopeChallenge)
        )
      : await createAuthenticatedHandler(props, connection, scopeChallenge).fetch(request)

  const challenge = scopeChallenge.response
  if (
    challenge &&
    challengeDeliveryFromUrl(request.url) === 'http' &&
    response.headers.get('Content-Type')?.includes('application/json')
  ) {
    await response.body?.cancel()
    return withCors(challenge, request)
  }
  return withCors(response, request)
}

/** workers-oauth-provider API handler: `ctx.props` holds the grant, `ctx.auth` the verified token. */
export const oauthMcpHandler = {
  // The provider's apiHandlers type predates ctx.auth, so it is optional here.
  fetch(
    request: Request,
    _env: Env,
    ctx: ExecutionContext & Partial<Pick<OAuthResourceContext<unknown>, 'auth'>>
  ) {
    return handleAuthenticatedMcpRequest(request, ctx.props, ctx.auth)
  }
}

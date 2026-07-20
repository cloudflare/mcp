import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse
} from '@modelcontextprotocol/server'
import { createServer } from './server'
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

function createAuthenticatedHandler(props: AuthProps) {
  return createMcpHandler(({ requestInfo }) => {
    if (!requestInfo) {
      throw new Error('The Cloudflare MCP server requires an HTTP request')
    }

    const codemode = new URL(requestInfo.url).searchParams.get('codemode') !== 'false'
    return createServer(props, codemode)
  })
}

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
  rawProps: unknown
): Promise<Response> {
  if (new URL(request.url).pathname !== MCP_ROUTE) {
    return new Response('Not Found', { status: 404 })
  }

  const rejected = rejectInvalidMcpRequest(request)
  if (rejected) return rejected

  const props = AuthPropsSchema.parse(rawProps)
  const handler = createAuthenticatedHandler(props)
  return withCors(await handler.fetch(request), request)
}

/** ExportedHandler adapter required by workers-oauth-provider 0.8.x. */
export const oauthMcpHandler = {
  fetch(request: Request, _env: Env, ctx: ExecutionContext) {
    return handleAuthenticatedMcpRequest(request, ctx.props)
  }
}

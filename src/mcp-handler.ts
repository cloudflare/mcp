import type {
  OAuthHelpers,
  OAuthResourceAuth,
  OAuthResourceContext
} from '@cloudflare/workers-oauth-provider'
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
import { createServer, type RequestContext, type ServerOptions } from './server'
import { connectionFromAuth } from './api-permissions'
import { ScopeChallenge } from './scope-challenge'
import { identifyClient, type ClientBehavior } from './clients'
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
 * Read the server options from the MCP URL query string.
 *
 * - `codemode` stays on unless the client passes exactly `false`, e.g.
 *   `/mcp?codemode=false`.
 * - `experimentalForge` is off unless it is exactly `true`, e.g.
 *   `/mcp?codemode=false&experimentalForge=true`.
 * - `experimentalOutputSchema` is off unless it is exactly `true`. It applies
 *   only with the two above, e.g.
 *   `/mcp?codemode=false&experimentalForge=true&experimentalOutputSchema=true`.
 * - Without `truncateToolResult`, `createServer` picks the default for the tool
 *   mode. With it, truncation is on unless the value is exactly `false`.
 */
function serverOptionsFromUrl(url: string): ServerOptions {
  const params = new URL(url).searchParams
  const truncate = params.get('truncateToolResult')
  return {
    codemode: params.get('codemode') !== 'false',
    experimentalForge: params.get('experimentalForge') === 'true',
    experimentalOutputSchema: params.get('experimentalOutputSchema') === 'true',
    ...(truncate === null ? {} : { truncateToolResult: truncate !== 'false' })
  }
}

/** `/mcp?scopeChallenge=http|tool` overrides the client's challenge delivery, for testing a client. */
function challengeDeliveryOverride(url: string): ClientBehavior['scopeChallenge'] | undefined {
  const value = new URL(url).searchParams.get('scopeChallenge')
  return value === 'http' || value === 'tool' ? value : undefined
}

function createAuthenticatedHandler(props: AuthProps, context: RequestContext) {
  return createMcpHandler(({ requestInfo }) => {
    if (!requestInfo) {
      throw new Error('The Cloudflare MCP server requires an HTTP request')
    }

    return createServer(props, serverOptionsFromUrl(requestInfo.url), context)
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

/** Reads a registered OAuth client's redirect URIs. */
export type LookupRedirectUris = (clientId: string) => Promise<readonly string[]>

/**
 * How this request's client takes a step-up challenge: the URL override, else
 * its behavior in `src/clients.ts`. Called only once a tool has recorded a
 * challenge, because identifying a registered client costs a KV read.
 */
async function challengeDelivery(
  url: string,
  clientId: string,
  lookupRedirectUris: LookupRedirectUris
): Promise<ClientBehavior['scopeChallenge']> {
  const override = challengeDeliveryOverride(url)
  if (override) return override
  const { behavior } = await identifyClient({
    clientId,
    redirectUris: () => lookupRedirectUris(clientId)
  })
  return behavior.scopeChallenge
}

/** What the MCP route receives besides the request and `ctx.props`. */
export interface AuthenticatedRequest {
  /** The Worker environment. MCP Events are served only when it is present. */
  readonly env?: Env
  /** `ctx.auth` from workers-oauth-provider: the verified token's client and scopes. */
  readonly auth?: OAuthResourceAuth
  /** Reads a registered client's redirect URIs, to identify it (`src/clients.ts`). */
  readonly lookupRedirectUris?: LookupRedirectUris
}

/**
 * Serve one authenticated MCP exchange with a fresh SDK v2 server instance.
 *
 * @param request - The MCP HTTP request.
 * @param rawProps - `ctx.props` from workers-oauth-provider.
 * @param authenticated - The Worker environment, the verified token, and a client lookup.
 */
export async function handleAuthenticatedMcpRequest(
  request: Request,
  rawProps: unknown,
  { env, auth, lookupRedirectUris = async () => [] }: AuthenticatedRequest = {}
): Promise<Response> {
  if (new URL(request.url).pathname !== MCP_ROUTE) {
    return new Response('Not Found', { status: 404 })
  }

  const rejected = rejectInvalidMcpRequest(request)
  if (rejected) return rejected

  const props = AuthPropsSchema.parse(rawProps)
  const connection = connectionFromAuth(auth)
  // Only tokens this server issued can step up; their tools can ask for a scope.
  const issued = connection.kind === 'oauth' ? auth : undefined
  const scopeChallenge = new ScopeChallenge(issued)
  // Both serving paths build their server from this one context, so neither drops MCP Events.
  const context: RequestContext = {
    connection,
    scopeChallenge,
    ...(env && {
      events: {
        env,
        bearer: request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
      }
    })
  }

  const response =
    issued && request.method === 'POST' && (await isLegacyRequest(request))
      ? await serveLegacyAsJson(
          request,
          await createServer(props, serverOptionsFromUrl(request.url), context)
        )
      : await createAuthenticatedHandler(props, context).fetch(request)

  const challenge = scopeChallenge.response
  if (
    challenge &&
    issued?.clientId &&
    response.headers.get('Content-Type')?.includes('application/json') &&
    (await challengeDelivery(request.url, issued.clientId, lookupRedirectUris)) === 'http'
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
    env: Env & { OAUTH_PROVIDER?: OAuthHelpers },
    ctx: ExecutionContext & Partial<Pick<OAuthResourceContext<unknown>, 'auth'>>
  ) {
    return handleAuthenticatedMcpRequest(request, ctx.props, {
      env,
      auth: ctx.auth,
      lookupRedirectUris: async (clientId) => {
        const client = await env.OAUTH_PROVIDER?.lookupClient(clientId)
        return client?.redirectUris ?? []
      }
    })
  }
}

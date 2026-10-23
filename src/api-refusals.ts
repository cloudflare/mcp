import {
  authorize,
  emptyListProvesNothing,
  explainRefusal,
  findOperation,
  isRefusal,
  type Authorization,
  type Connection,
  type EndpointAccess
} from './api-permissions'
import { getMcpTools, type McpTools } from './isolate-cache'

/**
 * Header `GlobalOutbound` sets on a refused response so the `execute` sandbox
 * can put the explanation in the error it throws. URI-encoded.
 */
export const REFUSAL_HINT_HEADER = 'X-Cloudflare-MCP-Refusal-Hint'

/** Header `GlobalOutbound` sets on a refused response naming the OAuth scope to challenge for. */
export const MISSING_SCOPE_HEADER = 'X-Cloudflare-MCP-Missing-Scope'

/** A Cloudflare API answer that refused the request, and what it tells the agent and the client. */
export interface Refusal {
  /** The status to report: Cloudflare's, or 403 for a list emptied by permission. */
  readonly status: 401 | 403
  /** Guidance for the agent. */
  readonly hint: string
  /** The OAuth scope that would let the request through, when one can be named. */
  readonly scope: string | undefined
  /** Whether Cloudflare answered with an empty list that this server refused instead. */
  readonly filtered: boolean
}

/** Why a `200` with an empty list became a 403. Stands in for Cloudflare's errors. */
export const FILTERED_LIST_ERROR =
  'Cloudflare answered 200 with an empty list, which is also how it answers a connection that may not see any of them, so this server refused the request'

/** The Cloudflare-shaped body reported in place of an empty list refused as 403. */
export function filteredListBody(): {
  success: false
  errors: { message: string }[]
  messages: []
  result: null
} {
  return { success: false, errors: [{ message: FILTERED_LIST_ERROR }], messages: [], result: null }
}

/**
 * Whether a response body is an empty list: the REST envelope's `result`, or a
 * bare array from an API without the envelope.
 */
export function isEmptyList(body: unknown): boolean {
  const list =
    body !== null && typeof body === 'object' && !Array.isArray(body) && 'result' in body
      ? body.result
      : body
  return Array.isArray(list) && list.length === 0
}

/**
 * Decide whether a Cloudflare API answer refused the request.
 *
 * A 401 or 403 did. So did a `200` with an empty list for a GET the
 * connection holds no accepted scope for: Cloudflare filters some lists to what
 * the credential may see instead of refusing (see {@link emptyListProvesNothing}),
 * so it gets the same explanation and step-up as a 403.
 *
 * @param status - The HTTP status Cloudflare returned.
 * @param body - The parsed response body, when there is one.
 * @param method - The request method.
 * @param authorization - The decision for the request, from {@link authorize}.
 * @param permissions - The API token permissions the endpoint accepts.
 * @returns The refusal, or `undefined` when the answer stands.
 */
export function refusalFor(
  status: number,
  body: unknown,
  method: string,
  authorization: Authorization,
  permissions: readonly string[] | undefined
): Refusal | undefined {
  const scope = authorization.kind === 'missing' ? authorization.scope : undefined
  if (isRefusal(status)) {
    return { status, hint: explainRefusal(status, authorization), scope, filtered: false }
  }
  if (
    status >= 200 &&
    status < 300 &&
    isEmptyList(body) &&
    emptyListProvesNothing(method, authorization, permissions)
  ) {
    return { status: 403, hint: explainRefusal(403, authorization), scope, filtered: true }
  }
  return undefined
}

type AccessPaths = Record<string, Record<string, EndpointAccess>>

let accessPaths: { tools: McpTools; paths: AccessPaths } | undefined

/**
 * What every operation accepts, by path template and method, taken from the
 * cached `mcp-tools.json` rather than `spec.json`: the tool catalog is a few
 * MB and already shared per isolate, while parsing the ~25 MB spec in the
 * request path could exhaust the isolate's memory.
 */
async function getAccessPaths(): Promise<AccessPaths> {
  const tools = await getMcpTools()
  if (accessPaths?.tools !== tools) {
    const paths: AccessPaths = {}
    for (const { path, method, permissions, scopes } of tools.byName.values()) {
      paths[path] ??= {}
      paths[path][method] = { permissions, scopes }
    }
    accessPaths = { tools, paths }
  }
  return accessPaths.paths
}

/**
 * The endpoint a request goes to, and what it accepts.
 *
 * @param method - The request method.
 * @param path - The request path below the API base.
 * @returns The endpoint's template and access, or `undefined` when the catalog lacks it.
 */
export async function findEndpoint(
  method: string,
  path: string
): Promise<{ template: string; access: EndpointAccess } | undefined> {
  const match = findOperation(await getAccessPaths(), method, path)
  return match && { template: match.template, access: match.operation }
}

/** An empty list with `result_info` is a couple of hundred bytes; longer bodies aren't read. */
const MAX_EMPTY_LIST_BYTES = 4096

function isJson(response: Response): boolean {
  const type = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
  return type === 'application/json' || type.endsWith('+json')
}

/** Whether a successful response could be a list Cloudflare emptied by permission. */
function mayBeFilteredList(response: Response, connection: Connection, method: string): boolean {
  const length = Number(response.headers.get('content-length') ?? 0)
  return (
    connection.kind === 'oauth' &&
    method.toUpperCase() === 'GET' &&
    response.ok &&
    isJson(response) &&
    !(length > MAX_EMPTY_LIST_BYTES)
  )
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Review a Cloudflare API response for `execute`, which sends arbitrary
 * paths: look the endpoint up in `mcp-tools.json`, and report a refusal the
 * way the sandbox expects it.
 *
 * A 401 or 403 keeps its status and body and gains the explanation headers. A
 * list emptied by permission becomes a 403 with {@link filteredListBody}. Any
 * other response is returned as it is. The catalog is read only for refusals
 * and for successful JSON GETs from OAuth connections, and a body only once the
 * connection is known to hold no scope the endpoint accepts.
 *
 * @param response - Cloudflare's response.
 * @param connection - The credential that made the request.
 * @param method - The request method.
 * @param path - The request path below the API base.
 * @returns The response for the sandbox.
 */
export async function reviewResponse(
  response: Response,
  connection: Connection,
  method: string,
  path: string
): Promise<Response> {
  const refused = isRefusal(response.status)
  if (!refused && !mayBeFilteredList(response, connection, method)) return response

  const match = await findEndpoint(method, path).catch(() => undefined)
  // Without the catalog a refusal is still explained, from the status alone.
  if (!match && !refused) return response
  const permissions = match?.access.permissions
  const authorization = authorize(
    connection,
    { method, path, template: match?.template },
    match?.access
  )

  if (refused) {
    const refusal = refusalFor(response.status, undefined, method, authorization, permissions)
    return refusal ? withRefusalHeaders(response, response.body, refusal) : response
  }
  if (!emptyListProvesNothing(method, authorization, permissions)) return response

  const text = await response.text()
  const refusal = refusalFor(response.status, parseJson(text), method, authorization, permissions)
  if (!refusal) {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }
  const refused403 = new Response(null, {
    status: refusal.status,
    headers: { 'Content-Type': 'application/json' }
  })
  return withRefusalHeaders(refused403, JSON.stringify(filteredListBody()), refusal)
}

function withRefusalHeaders(response: Response, body: BodyInit | null, refusal: Refusal): Response {
  const headers = new Headers(response.headers)
  headers.set(REFUSAL_HINT_HEADER, encodeURIComponent(refusal.hint))
  if (refusal.scope) headers.set(MISSING_SCOPE_HEADER, refusal.scope)
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

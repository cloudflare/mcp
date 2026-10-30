import { isLegacyRequest, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server'
import type { Tool } from '@modelcontextprotocol/server'
import { DOCS_TOOL } from './docs-search'
import { WHOAMI_TOOL } from './whoami'
import { isolate } from '../lib/isolate'

/**
 * A plain `tools/list` request body is a few hundred bytes. Anything larger is
 * left to the SDK, so the fast path never buffers a large body twice.
 */
const MAX_BODY_BYTES = 4096

/**
 * Each direct-tool listing as UTF-8 JSON, encoded once per cached listing and
 * so again whenever the listing's own cache reloads. Bytes, not a string:
 * building and encoding a 3.7 MB string per response costs about as much as
 * the stringify this replaces.
 */
const toolsJson = isolate.derived((tools: readonly Tool[]) =>
  new TextEncoder().encode(JSON.stringify([DOCS_TOOL, WHOAMI_TOOL, ...tools]))
)

/** A lone 2025-era `tools/list` request for the first page, or `undefined` for anything else. */
async function plainToolListRequestId(request: Request): Promise<string | number | undefined> {
  if (request.method !== 'POST') return undefined
  if (!request.headers.get('Content-Type')?.includes('application/json')) return undefined
  // The SDK answers 406 without both; leave that to it.
  const accept = request.headers.get('Accept') ?? ''
  if (!accept.includes('application/json') || !accept.includes('text/event-stream'))
    return undefined
  // The SDK answers an unsupported version header with an error; leave that to it.
  const version = request.headers.get('MCP-Protocol-Version')
  if (version !== null && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) return undefined
  const length = Number(request.headers.get('Content-Length') ?? 0)
  if (!(length <= MAX_BODY_BYTES)) return undefined

  const text = await request.clone().text()
  if (text.length > MAX_BODY_BYTES) return undefined
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const { jsonrpc, id, method, params } = body as Record<string, unknown>
  if (jsonrpc !== '2.0' || method !== 'tools/list') return undefined
  if (typeof id !== 'string' && typeof id !== 'number') return undefined
  // Only the first page: a cursor, or anything but `_meta`, goes to the SDK.
  if (params !== undefined) {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) return undefined
    if (Object.keys(params).some((key) => key !== '_meta')) return undefined
  }
  // A 2026-07-28 request carries its protocol version in `_meta`; the SDK serves those.
  if (!(await isLegacyRequest(request, body))) return undefined
  return id
}

/**
 * Answer a lone 2025-era `tools/list` for the direct tools from text
 * serialized once per isolate, instead of letting the SDK stringify the
 * ~3,800 tools (~3.7 MB) on every request. In production that stringify was
 * most of the CPU `?codemode=false` used: clients list the tools far more
 * often than they call one.
 *
 * The listing is the one the SDK would send: `docs`, `whoami`, then `tools`.
 * 2025-era listings carry no output schemas, so the SDK's legacy encoding
 * leaves every tool as it is. Any other request returns `undefined` and is
 * served by the SDK as before.
 *
 * @param request - The authenticated MCP request.
 * @param listTools - The cached direct-tool listing, without `docs` and `whoami`.
 */
export async function cachedToolListResponse(
  request: Request,
  listTools: () => Promise<readonly Tool[]>
): Promise<Response | undefined> {
  const id = await plainToolListRequestId(request)
  if (id === undefined) return undefined
  const tools = toolsJson(await listTools())
  const body = new Blob([
    '{"result":{"tools":',
    tools,
    `},"jsonrpc":"2.0","id":${JSON.stringify(id)}}`
  ])
  return new Response(body, { headers: { 'Content-Type': 'application/json' } })
}

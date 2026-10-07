import { z } from 'zod'
import { env } from 'cloudflare:workers'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import type { FormatToolResult } from '../truncate'
import { fetchWithRetry } from '../utils/fetch-retry'
import { getDirectTools } from '../isolate-cache'
import {
  NON_CODEMODE_ACCOUNT_DISCOVERY_GUIDANCE,
  autoResolvedAccountId,
  missingAccountMessage,
  unknownAccountHint
} from '../auth/account-access'
import { recordToolCall } from '../metrics'
import { DOCS_TOOL, runDocsTool } from './docs-search'
import { WHOAMI_TOOL, WhoamiInputSchema, runWhoamiTool } from './whoami'
import type { McpTool, ParameterRoute } from '../mcp-tools'
import type { AuthProps } from '../auth/types'

/**
 * Serve the generated direct tools (`mcp-tools.json`) with two low-level
 * handlers. `tools/list` returns the cached catalogue as-is; `tools/call`
 * looks the tool up by name and turns its arguments into one Cloudflare API
 * request using the tool's precomputed `request` routing. The Cloudflare API
 * validates argument values; this only enforces the schema's required keys.
 */
export async function registerNonCodemodeTools(
  server: McpServer,
  props: AuthProps,
  formatResult: FormatToolResult
): Promise<void> {
  const tools = await getDirectTools()

  server.server.setRequestHandler('tools/list', () => ({
    tools: [DOCS_TOOL, WHOAMI_TOOL, ...tools.list]
  }))

  server.server.setRequestHandler('tools/call', async (request) => {
    const name = request.params.name
    const args = request.params.arguments ?? {}
    let result: CallToolResult

    try {
      if (name === DOCS_TOOL.name) {
        const parsed = z.object({ query: z.string() }).safeParse(args)
        result = parsed.success
          ? await runDocsTool(parsed.data.query)
          : toolError(
              `Input validation error: Invalid arguments for tool ${name}: ${parsed.error.message}`
            )
      } else if (name === WHOAMI_TOOL.name) {
        const parsed = WhoamiInputSchema.safeParse(args)
        result = parsed.success
          ? runWhoamiTool(props)
          : toolError(
              `Input validation error: Invalid arguments for tool ${name}: ${parsed.error.message}`
            )
      } else {
        const tool = tools.byName.get(name)
        result = tool
          ? await callDirectTool(tool, args, props, formatResult)
          : toolError(`Tool ${name} not found`)
      }
    } catch (error) {
      result = toolError(error instanceof Error ? error.message : String(error))
    }

    recordToolCall(props, name, result.isError === true)
    return result
  })
}

async function callDirectTool(
  tool: McpTool,
  input: Record<string, unknown>,
  props: AuthProps,
  formatResult: FormatToolResult
): Promise<CallToolResult> {
  const { request } = tool
  const args = { ...input }
  const accountRoute = request.pathParams.find(({ name }) => name === 'account_id')
  if (accountRoute && args[accountRoute.key] === undefined) {
    const accountId = autoResolvedAccountId(props)
    if (!accountId) {
      return toolError(missingAccountMessage(props, NON_CODEMODE_ACCOUNT_DISCOVERY_GUIDANCE))
    }
    args[accountRoute.key] = accountId
  }

  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined)
  if (missing.length) {
    return toolError(
      `Input validation error: Invalid arguments for tool ${tool.name}: missing required ${missing.join(', ')}`
    )
  }

  let path = request.path
  for (const route of request.pathParams) {
    path = path.replaceAll(`{${route.name}}`, encodeURIComponent(scalar(args[route.key])))
  }

  const url = new URL(env.CLOUDFLARE_API_BASE + path)
  for (const route of request.queryParams) {
    appendQuery(url.searchParams, route, args[route.key])
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${props.accessToken}` }
  for (const route of request.headerParams) {
    if (args[route.key] !== undefined) headers[route.name] = scalar(args[route.key])
  }
  const cookies = request.cookieParams
    .filter((route) => args[route.key] !== undefined)
    .map((route) => `${route.name}=${encodeURIComponent(scalar(args[route.key]))}`)
  if (cookies.length) headers['Cookie'] = cookies.join('; ')

  let body: BodyInit | undefined
  if (request.body && args['body'] !== undefined) {
    const contentType =
      typeof args['content_type'] === 'string' ? args['content_type'] : request.body.contentType
    body = encodeBody(args['body'], contentType)
    // FormData sets its own multipart boundary.
    if (!(body instanceof FormData)) headers['Content-Type'] = contentType
  }

  const response = await fetchWithRetry(
    url.toString(),
    { method: request.method, headers, body },
    { caller: 'non_codemode_tool_call' }
  )
  const contentType = response.headers.get('content-type') || ''
  const result = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  const accountId = accountRoute ? args[accountRoute.key] : undefined
  const hint =
    !response.ok && typeof accountId === 'string' ? unknownAccountHint(props, accountId) : ''
  return {
    content: [{ type: 'text', text: formatResult(result) + (hint ? `\n\n${hint}` : '') }],
    isError: !response.ok
  }
}

function scalar(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** OpenAPI `form` serialization: exploded arrays repeat the name, others join with commas. */
function appendQuery(params: URLSearchParams, route: ParameterRoute, value: unknown): void {
  if (value === undefined || value === null) return
  if (Array.isArray(value)) {
    if (route.explode) for (const item of value) params.append(route.name, scalar(item))
    else params.append(route.name, value.map(scalar).join(','))
  } else if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (route.explode) for (const [key, item] of entries) params.append(key, scalar(item))
    else params.append(route.name, entries.flat().map(scalar).join(','))
  } else {
    params.append(route.name, String(value))
  }
}

function encodeBody(value: unknown, contentType: string): BodyInit {
  if (contentType.startsWith('multipart/form-data') && isRecord(value)) {
    const form = new FormData()
    for (const [key, item] of Object.entries(value)) {
      for (const part of Array.isArray(item) ? item : [item]) form.append(key, scalar(part))
    }
    return form
  }
  if (contentType.startsWith('application/x-www-form-urlencoded') && isRecord(value)) {
    return new URLSearchParams(
      Object.entries(value).map(([key, item]) => [key, scalar(item)])
    ).toString()
  }
  if (typeof value !== 'string') return JSON.stringify(value)
  // A JSON body passed as already-serialized text goes through unchanged.
  return contentType.includes('json') && !isJsonText(value) ? JSON.stringify(value) : value
}

function isJsonText(value: string): boolean {
  try {
    JSON.parse(value)
    return true
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

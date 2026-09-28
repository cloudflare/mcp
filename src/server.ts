import { McpServer } from '@modelcontextprotocol/server'
import { registerDocsTool } from './tools/docs-search'
import { registerNonCodemodeTools } from './tools/non-codemode'
import { registerSearchTool } from './tools/search'
import { registerExecuteTool } from './tools/execute'
import { attachMetrics } from './metrics'
import { ENDPOINT_TOOLS_SERVER_INFO, SERVER_INFO } from './constants'
import { stringifyResponse, truncateResponse } from './truncate'
import type { AuthProps } from './auth/types'

/**
 * How long a client may reuse a `tools/list` result. Tool lists change only on
 * deploy or the daily spec refresh, and a warm isolate already serves the spec
 * artifacts for up to an hour.
 */
const TOOL_LIST_TTL_MS = 60 * 60 * 1000

/** Per-request options the client picks through the MCP URL query string. */
export interface ServerOptions {
  /**
   * Register the Code Mode tools (`docs`, `search`, `execute`). When `false`,
   * register one tool per API endpoint instead. Defaults to `true`.
   */
  readonly codemode?: boolean
  /**
   * Cap each tool result at ~6,000 tokens. When `false`, results are returned
   * whole. Defaults to `true`.
   */
  readonly truncateToolResult?: boolean
}

/**
 * Build the MCP server for one authenticated request.
 *
 * @param props - The validated credentials for the request.
 * @param options - The tool surface and result shaping the client asked for.
 * @returns A fresh server with the requested tools registered.
 */
export async function createServer(
  props: AuthProps,
  { codemode = true, truncateToolResult = true }: ServerOptions = {}
): Promise<McpServer> {
  // Tool metadata is the same for every caller, and the "tool metadata is
  // identical for every user" tests keep it that way. So clients and shared
  // gateways may serve one caller's tool list to everyone until the TTL runs out.
  const server = new McpServer(codemode ? SERVER_INFO : ENDPOINT_TOOLS_SERVER_INFO, {
    cacheHints: { 'tools/list': { ttlMs: TOOL_LIST_TTL_MS, cacheScope: 'public' } }
  })
  const formatResult = truncateToolResult ? truncateResponse : stringifyResponse

  if (!codemode) {
    await registerNonCodemodeTools(server, props, formatResult)
    return server
  }

  // Track tool_call metrics for every Code-Mode tool registered below. The
  // metrics wrapper also mirrors tool.title into annotations.title.
  attachMetrics(server, props)
  registerDocsTool(server)
  await registerSearchTool(server, formatResult)
  registerExecuteTool(server, props, formatResult)

  return server
}

import { McpServer } from '@modelcontextprotocol/server'
import { registerDocsTool } from './tools/docs-search'
import { registerNonCodemodeTools } from './tools/non-codemode'
import { registerSearchTool } from './tools/search'
import { registerExecuteTool } from './tools/execute'
import { registerWhoamiTool } from './tools/whoami'
import { attachMetrics } from './metrics'
import { SERVER_INFO } from './constants'
import { stringifyResponse, truncateResponse } from './truncate'
import type { AuthProps } from './auth/types'
import { DIRECT_CONNECTION, type Connection } from './api-permissions'

/** Per-request options the client picks through the MCP URL query string. */
export interface ServerOptions {
  /**
   * Register the Code Mode tools (`search`, `execute`). When `false`, register
   * one tool per API endpoint instead. `docs` and `whoami` are registered in
   * both modes. Defaults to `true`.
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
 * @param connection - What the request's token is allowed to do, for explaining refused API calls.
 * @returns A fresh server with the requested tools registered.
 */
export async function createServer(
  props: AuthProps,
  { codemode = true, truncateToolResult = true }: ServerOptions = {},
  connection: Connection = DIRECT_CONNECTION
): Promise<McpServer> {
  const server = new McpServer(SERVER_INFO)
  // The tool set is fixed for the life of each per-request server, so this
  // server never sends notifications/tools/list_changed. Declare that before
  // registerTool can default the capability to true.
  server.server.registerCapabilities({ tools: { listChanged: false } })
  const formatResult = truncateToolResult ? truncateResponse : stringifyResponse

  if (!codemode) {
    await registerNonCodemodeTools(server, props, formatResult, connection)
    return server
  }

  // Track tool_call metrics for every Code-Mode tool registered below. The
  // metrics wrapper also mirrors tool.title into annotations.title.
  attachMetrics(server, props)
  registerDocsTool(server)
  await registerSearchTool(server, formatResult)
  registerExecuteTool(server, props, formatResult, connection)
  registerWhoamiTool(server, props)

  return server
}

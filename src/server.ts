import { McpServer } from '@modelcontextprotocol/server'
import { registerDocsTool } from './tools/docs-search'
import { registerNonCodemodeTools } from './tools/non-codemode'
import { registerSearchTool } from './tools/search'
import { registerExecuteTool } from './tools/execute'
import { attachMetrics } from './metrics'
import { SERVER_INFO } from './constants'
import { stringifyResponse, truncateResponse } from './truncate'
import type { AuthProps } from './auth/types'

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
  const server = new McpServer(SERVER_INFO)
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

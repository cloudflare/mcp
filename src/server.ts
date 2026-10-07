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
import { ScopeChallenge } from './scope-challenge'

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
  /**
   * The protocol era the SDK serves this request in. Only `modern`
   * (2026-07-28) clients get direct-tool `outputSchema` and
   * `structuredContent`; `legacy` clients get exactly the 2025 behaviour.
   * Defaults to `legacy`.
   */
  readonly era?: 'legacy' | 'modern'
}

/**
 * Build the MCP server for one authenticated request.
 *
 * @param props - The validated credentials for the request.
 * @param options - The tool surface and result shaping the client asked for.
 * @param connection - What the request's token is allowed to do, for explaining refused API calls.
 * @param scopeChallenge - Where tools record a scope the request needs, for a step-up challenge.
 * @returns A fresh server with the requested tools registered.
 */
export async function createServer(
  props: AuthProps,
  { codemode = true, truncateToolResult = true, era = 'legacy' }: ServerOptions = {},
  connection: Connection = DIRECT_CONNECTION,
  scopeChallenge = new ScopeChallenge(undefined)
): Promise<McpServer> {
  const server = new McpServer(SERVER_INFO)
  // The tool set is fixed for the life of each per-request server, so this
  // server never sends notifications/tools/list_changed. Declare that before
  // registerTool can default the capability to true.
  server.server.registerCapabilities({ tools: { listChanged: false } })
  const formatResult = truncateToolResult ? truncateResponse : stringifyResponse

  if (!codemode) {
    await registerNonCodemodeTools(server, props, formatResult, connection, scopeChallenge, era)
    return server
  }

  // Track tool_call metrics for every Code-Mode tool registered below. The
  // metrics wrapper also mirrors tool.title into annotations.title.
  attachMetrics(server, props)
  registerDocsTool(server)
  await registerSearchTool(server, formatResult)
  registerExecuteTool(server, props, formatResult, connection, scopeChallenge)
  registerWhoamiTool(server, props)

  return server
}

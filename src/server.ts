import { McpServer } from '@modelcontextprotocol/server'
import { registerDocsTool } from './tools/docs-search'
import { registerNonCodemodeTools } from './tools/non-codemode'
import { registerForgeTools } from './tools/forge-tools'
import { registerSearchTool } from './tools/search'
import { registerExecuteTool } from './tools/execute'
import { registerWhoamiTool } from './tools/whoami'
import { registerAttentionTool } from './apps/attention/tool'
import { registerSkills } from './skills/handlers'
import { attachMetrics } from './metrics'
import { SERVER_INFO } from './constants'
import { stringifyResponse, truncateResponse } from './truncate'
import type { AuthProps } from './auth/types'
import { registerEventMethods } from './events/methods'
import type { EventEnvironment } from './events/state'
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
   * With `codemode: false`, build the direct tools from the code Forge
   * generates instead of `mcp-tools.json`. Opt-in while it soaks; it is meant
   * to become how `codemode: false` works. Ignored in Code Mode, which already
   * reads the Forge spec. Defaults to `false`.
   */
  readonly experimentalForge?: boolean
  /**
   * With `codemode: false` and `experimentalForge: true`, give 2026-07-28
   * requests each tool's generated output schema in `tools/list` and a
   * successful call's whole response body as `structuredContent`. 2025-era
   * requests are served as without it: their clients expect an object output
   * schema, and most generated ones aren't. Ignored otherwise.
   * Defaults to `false`.
   */
  readonly experimentalOutputSchema?: boolean
  /**
   * Cap each tool result at ~6,000 tokens. When `false`, results are returned
   * whole. Defaults to `true` in Code Mode and `false` for the direct tools.
   * In Code Mode it is only the default: each `search` or `execute` call can
   * override it with its `truncate` argument.
   */
  readonly truncateToolResult?: boolean
}

/** What one authenticated request brings besides its credentials. */
export interface RequestContext {
  /** What the request's token is allowed to do, for explaining refused API calls. */
  readonly connection: Connection
  /** Where tools record a scope the request needs, for a step-up challenge. */
  readonly scopeChallenge: ScopeChallenge
  /** MCP Events, served when the Worker environment is available. */
  readonly events?: { readonly env: EventEnvironment; readonly bearer: string }
}

/** A request whose credential can't step up and that serves no events, e.g. in tests. */
export function directRequestContext(): RequestContext {
  return { connection: DIRECT_CONNECTION, scopeChallenge: new ScopeChallenge(undefined) }
}

/**
 * Build the MCP server for one authenticated request.
 *
 * @param props - The validated credentials for the request.
 * @param options - The tool surface and result shaping the client asked for.
 * @param context - The request's connection, step-up challenge and MCP Events environment.
 * @returns A fresh server with the requested tools and the skills catalog registered.
 */
export async function createServer(
  props: AuthProps,
  {
    codemode = true,
    experimentalForge = false,
    experimentalOutputSchema = false,
    truncateToolResult = codemode
  }: ServerOptions = {},
  { connection, scopeChallenge, events }: RequestContext = directRequestContext()
): Promise<McpServer> {
  const server = new McpServer(SERVER_INFO)
  // The tool set is fixed for the life of each per-request server, so this
  // server never sends notifications/tools/list_changed. Declare that before
  // registerTool can default the capability to true.
  server.server.registerCapabilities({ tools: { listChanged: false } })
  // Skills (io.modelcontextprotocol/skills) are served in both tool modes.
  registerSkills(server)
  if (events) registerEventMethods(server, events.env, props, events.bearer)
  if (!codemode) {
    const formatResult = truncateToolResult ? truncateResponse : stringifyResponse
    if (experimentalForge) {
      registerForgeTools(server, props, formatResult, connection, scopeChallenge, {
        outputSchema: experimentalOutputSchema
      })
    } else {
      await registerNonCodemodeTools(server, props, formatResult, connection, scopeChallenge)
    }
    return server
  }

  // Track tool_call metrics for every Code-Mode tool registered below. The
  // metrics wrapper also mirrors tool.title into annotations.title.
  attachMetrics(server, props)
  registerDocsTool(server)
  await registerSearchTool(server, truncateToolResult)
  registerExecuteTool(server, props, truncateToolResult, connection, scopeChallenge)
  registerWhoamiTool(server, props)
  registerAttentionTool(server, props)

  return server
}

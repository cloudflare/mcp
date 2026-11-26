import { McpServer } from '@modelcontextprotocol/server'
import { registerDocsTool } from './tools/docs-search'
import { registerAppGeneratedTools, registerForgeTools } from './tools/forge-tools'
import { registerSearchTool } from './tools/search'
import { registerExecuteTool } from './tools/execute'
import { registerWhoamiTool } from './tools/whoami'
import { registerSubmitFeedbackTool } from './tools/submit-feedback'
import { registerSkills } from './skills/handlers'
import { MCP_APP_RESOURCES, registerMcpApps } from './mcp-apps/registry'
import { MCP_APPS_EXTENSION_ID } from './mcp-apps/capability'
import { attachMetrics } from './metrics'
import { SERVER_INFO } from './constants'
import { stringifyResponse, truncateResponse } from './truncate'
import type { AuthProps } from './auth/types'
import { registerEventMethods } from './events/methods'
import type { EventEnvironment } from './events/state'
import { DIRECT_CONNECTION } from './api-permissions'
import type { Connection } from './api-permissions'
import { ScopeChallenge } from './scope-challenge'

/** Per-request options the client picks through the MCP URL query string. */
export interface ServerOptions {
  /**
   * Register the Code Mode tools (`search`, `execute`). When `false`, register
   * the direct tools forge generates, one per API method, instead. `docs`,
   * `whoami` and the MCP Apps (`src/mcp-apps/registry.ts`) are registered in
   * both modes; see {@link RequestContext.mcpApps}. Defaults to `true`.
   */
  readonly codemode?: boolean
  /**
   * With `codemode: false`, give 2026-07-28
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
  /**
   * Whether the request's client declared MCP Apps (`declaresMcpApps`). Only
   * then are the Apps' views linked, their `ui://` pages listed and, in Code
   * Mode, the generated tools their views write with registered. Defaults to
   * `false`.
   */
  readonly mcpApps?: boolean
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
export function createServer(
  props: AuthProps,
  {
    codemode = true,
    experimentalOutputSchema = false,
    truncateToolResult = codemode
  }: ServerOptions = {},
  { connection, scopeChallenge, events, mcpApps = false }: RequestContext = directRequestContext()
): McpServer {
  const server = new McpServer(SERVER_INFO)
  // The tool set is fixed for the life of each per-request server, so this
  // server never sends notifications/tools/list_changed. Declare that before
  // registerTool can default the capability to true.
  // MCP Apps are declared to every client; what each request gets depends on
  // whether its client declared them too (`mcpApps`).
  server.server.registerCapabilities({
    tools: { listChanged: false },
    extensions: { [MCP_APPS_EXTENSION_ID]: {} }
  })
  // Skills (io.modelcontextprotocol/skills) are served in both tool modes.
  // MCP Apps' HTML resources are served next to the skills' files, listed only
  // to clients that declared MCP Apps. Reading one always works: the HTML is
  // static and the same for everyone.
  registerSkills(server, MCP_APP_RESOURCES, { listStatic: mcpApps })
  if (events) {
    registerEventMethods(server, events.env, props, events.bearer)
  }
  if (!codemode) {
    const formatResult = truncateToolResult ? truncateResponse : stringifyResponse
    registerForgeTools(server, props, formatResult, connection, scopeChallenge, {
      outputSchema: experimentalOutputSchema,
      mcpApps
    })
    return server
  }

  // Track tool_call metrics for every Code-Mode tool registered below. The
  // metrics wrapper also mirrors tool.title into annotations.title.
  attachMetrics(server, props)
  registerDocsTool(server)
  registerSearchTool(server, truncateToolResult)
  registerExecuteTool(server, props, truncateToolResult, connection, scopeChallenge)
  registerWhoamiTool(server, props)
  registerSubmitFeedbackTool(server, props)
  // Without MCP Apps, the Apps' tools are plain tools whose JSON text result is
  // the text-only fallback, and the writes only their views make aren't
  // registered: about 25 KB of `tools/list` the model must not call.
  registerMcpApps(server, { props, connection, scopeChallenge }, undefined, { view: mcpApps })
  if (mcpApps) registerAppGeneratedTools(server, { props, connection, scopeChallenge })

  return server
}

import type { McpServer, Tool } from '@modelcontextprotocol/server'
import type { StaticResource } from '../skills/handlers'
// App imports, one per line.
import { workersUsageAlertApp } from '../workers-usage-alert/tool'
import type { AppContext, McpApp } from './define'

const apps: McpApp[] = []
// Each App adds its import above and one push here; nothing else in the server
// changes. One statement per App, on either side of this comment, so Apps in
// flight at once merge in any order. See `docs/mcp-apps.md`.
apps.push(workersUsageAlertApp)

/** Every MCP App this Worker serves, in listing order. */
export const MCP_APPS: readonly McpApp[] = apps

/** The Apps' tools, for the direct tools' hand-written `tools/list`. */
export const MCP_APP_TOOLS: readonly Tool[] = MCP_APPS.map((app) => app.tool)

/** The Apps' HTML, served next to the skills' files. */
export const MCP_APP_RESOURCES: readonly StaticResource[] = MCP_APPS.map((app) => app.resource)

const BY_NAME: ReadonlyMap<string, McpApp> = new Map(MCP_APPS.map((app) => [app.tool.name, app]))

/** The App whose tool is `name`, for the direct tools' `tools/call`. */
export function mcpAppNamed(name: string): McpApp | undefined {
  return BY_NAME.get(name)
}

/**
 * Register every App's tool on a Code Mode server. The direct tools serve
 * them through `registerForgeTools` instead.
 *
 * @param server - The per-request MCP server.
 * @param context - The request's credential, connection and step-up challenge.
 * @param apps - Defaults to {@link MCP_APPS}; tests pass their own.
 */
export function registerMcpApps(
  server: McpServer,
  context: AppContext,
  apps: readonly McpApp[] = MCP_APPS
): void {
  for (const app of apps) {
    const { name, title, description, annotations, _meta } = app.tool
    server.registerTool(
      name,
      {
        title,
        description,
        annotations: { ...annotations },
        _meta,
        inputSchema: app.inputSchema,
        outputSchema: app.outputSchema
      },
      (args, ctx) => app.call(args, context, ctx)
    )
  }
}

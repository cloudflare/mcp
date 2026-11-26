import type { McpServer, Tool } from '@modelcontextprotocol/server'
import { cloudflareTool } from '../forge-tools/cloudflare'
import type { StaticResource } from '../skills/handlers'
// App imports, one per line.
import { workersBillingAlertApp, workersUsageAlertApp } from '../workers-usage-alert/tool'
import { r2StorageAlertApp } from '../r2-storage-alert/tool'
import { workersSpendLimitApp } from '../workers-spend-limit/tool'
import type { AppContext, McpApp } from './define'
import { withoutAppView } from './capability'

const apps: Array<McpApp> = []
// Each App adds its import above and one push here; nothing else in the server
// changes. One statement per App, on either side of this comment, so Apps in
// flight at once merge in any order.
apps.push(workersUsageAlertApp, workersBillingAlertApp)
// oxlint-disable-next-line unicorn/prefer-single-call -- One push per App keeps concurrent App branches mergeable.
apps.push(r2StorageAlertApp, workersSpendLimitApp)

/** Every MCP App this Worker serves, in listing order. */
export const MCP_APPS: ReadonlyArray<McpApp> = apps

/** The Apps' tools, for the direct tools' hand-written `tools/list` to clients that declare MCP Apps. */
export const MCP_APP_TOOLS: ReadonlyArray<Tool> = MCP_APPS.map((app) => app.tool)

/** The Apps' tools as clients without MCP Apps list them: plain tools, with no view. */
export const MCP_APP_TEXT_TOOLS: ReadonlyArray<Tool> = MCP_APP_TOOLS.map(withoutAppView)

/** The Apps' HTML, served next to the skills' files. */
export const MCP_APP_RESOURCES: ReadonlyArray<StaticResource> = MCP_APPS.map((app) => app.resource)

const BY_NAME: ReadonlyMap<string, McpApp> = new Map(MCP_APPS.map((app) => [app.tool.name, app]))

/** The App whose tool is `name`, for the direct tools' `tools/call`. */
export function mcpAppNamed(name: string): McpApp | undefined {
  return BY_NAME.get(name)
}

/**
 * Every generated tool an App's view calls, once each, as Code Mode lists it:
 * with the Cloudflare policy the direct tools have, and app-only.
 */
export const MCP_APP_GENERATED_TOOLS: ReadonlyArray<Tool> = [
  ...new Map(MCP_APPS.flatMap((app) => app.appTools).map((tool) => [tool.name, tool])).values()
].map((tool) => appOnly(cloudflareTool(tool)))

/** A generated tool as an App's view sees it in Code Mode: listed for the App only. */
export function appOnly<T extends Tool>(tool: T): T {
  const meta = tool._meta ?? {}
  // oxlint-disable-next-line quality/no-unsafe-dictionary-type, typescript/no-unsafe-type-assertion -- `_meta.ui` is the Apps extension's open object; only `visibility` is set here.
  const ui = (meta.ui ?? {}) as Record<string, unknown>
  return { ...tool, _meta: { ...meta, ui: { ...ui, visibility: ['app'] } } }
}

/**
 * Register every App's tool on a Code Mode server. The direct tools serve
 * them through `registerForgeTools` instead.
 *
 * @param server - The per-request MCP server.
 * @param context - The request's credential, connection and step-up challenge.
 * @param apps - Defaults to {@link MCP_APPS}; tests pass their own.
 * @param options.view - Whether the client declared MCP Apps. Without it each
 *   tool is listed as a plain tool (`withoutAppView`), whose JSON text result
 *   is the spec's text-only fallback.
 */
export function registerMcpApps(
  server: McpServer,
  context: AppContext,
  apps: ReadonlyArray<McpApp> = MCP_APPS,
  { view = true }: { view?: boolean } = {}
): void {
  for (const app of apps) {
    const { name, title, description, annotations, _meta } = view
      ? app.tool
      : withoutAppView(app.tool)
    server.registerTool(
      name,
      {
        title,
        description,
        annotations: { ...annotations },
        ...(_meta && { _meta }),
        inputSchema: app.inputSchema,
        outputSchema: app.outputSchema
      },
      (args, ctx) => app.call(args, { ...context, view }, ctx)
    )
  }
}

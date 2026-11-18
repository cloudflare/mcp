import type {
  CallToolResult,
  ServerContext,
  Tool,
  ToolAnnotations
} from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { AuthProps } from '../auth/types'
import type { Connection } from '../api-permissions'
import type { ScopeChallenge } from '../scope-challenge'
import type { StaticResource } from '../skills/handlers'
import { withCachedJsonSchema } from '../lib/isolate-json-schema'

/** The MIME type MCP Apps hosts render as an App. */
export const MCP_APP_MIME = 'text/html;profile=mcp-app'

/** What an App's collector gets from the authenticated request. */
export interface AppContext {
  /** The request's validated credential. Its token never reaches the App's HTML. */
  readonly props: AuthProps
  /** What the credential may do, for explaining refused API reads. */
  readonly connection: Connection
  /** Where a refused read records a missing OAuth scope, for step-up. */
  readonly scopeChallenge: ScopeChallenge
}

/** What an App's collector returns: its validated result, or a tool error. */
export type AppOutcome<Output> =
  | { readonly ok: true; readonly value: Output; readonly meta?: CallToolResult['_meta'] }
  | { readonly ok: false; readonly text: string; readonly meta?: CallToolResult['_meta'] }

/** An App's tool and its HTML resource, served in both tool modes. */
export interface McpApp {
  /** The tool as `tools/list` sends it, for the direct tools' hand-written listing. */
  readonly tool: Tool
  /** The App's HTML, served through `resources/list` and `resources/read`. */
  readonly resource: StaticResource
  /** The zod schemas Code Mode registers, JSON Schema conversion cached per isolate. */
  readonly inputSchema: z.ZodObject
  readonly outputSchema: z.ZodType
  /** Validate the arguments, run the collector and shape the result. */
  call(args: unknown, context: AppContext, ctx: ServerContext): Promise<CallToolResult>
}

export interface McpAppDefinition<Input extends z.ZodObject, Output extends z.ZodType> {
  /** The tool name, such as `workers_deployment_status`. A permanent contract. */
  readonly name: string
  readonly title: string
  /** When to call the tool, what it reads and what it doesn't prove. Hosts route on this. */
  readonly description: string
  readonly annotations: ToolAnnotations
  readonly input: Input
  readonly output: Output
  readonly resource: {
    /** `ui://cloudflare/<name>.html`. */
    readonly uri: `ui://${string}`
    readonly name: string
    /** The self-contained HTML `npm run app:build` generates. */
    readonly html: string
  }
  /** Collect the result. Reads must stop when `signal` aborts. */
  run(
    input: z.output<Input>,
    context: AppContext,
    signal: AbortSignal
  ): Promise<AppOutcome<z.output<Output>>>
}

/**
 * The signal a tool call stops on: the MCP request's, and the HTTP request's
 * when the client disconnects.
 */
export function toolSignal(ctx: ServerContext): AbortSignal {
  return ctx.http?.req
    ? AbortSignal.any([ctx.mcpReq.signal, ctx.http.req.signal])
    : ctx.mcpReq.signal
}

/**
 * Define an MCP App: a tool whose result an MCP Apps host renders with a
 * static HTML resource, and that clients without Apps read as JSON text and
 * `structuredContent`.
 *
 * Call it once at module scope. The App's HTML holds no account data or
 * credentials and makes no network requests (its CSP allows none); everything
 * it shows comes from the tool result.
 *
 * @param definition - The tool's contract, its HTML and its collector.
 * @returns The App, for `MCP_APPS` in `src/mcp-apps/registry.ts`.
 */
export function defineMcpApp<Input extends z.ZodObject, Output extends z.ZodType>(
  definition: McpAppDefinition<Input, Output>
): McpApp {
  const { uri, name: resourceName, html } = definition.resource
  const meta = { ui: { resourceUri: uri }, 'ui/resourceUri': uri }
  const tool: Tool = {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    annotations: definition.annotations,
    _meta: meta,
    inputSchema: z.toJSONSchema(definition.input) as Tool['inputSchema'],
    outputSchema: z.toJSONSchema(definition.output) as Tool['outputSchema']
  }
  const resource: StaticResource = {
    descriptor: { uri, name: resourceName, mimeType: MCP_APP_MIME },
    content: {
      uri,
      mimeType: MCP_APP_MIME,
      text: html,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } }
    }
  }
  return {
    tool,
    resource,
    inputSchema: withCachedJsonSchema(definition.input),
    outputSchema: withCachedJsonSchema(definition.output),
    async call(args, context, ctx) {
      const parsed = definition.input.safeParse(args)
      if (!parsed.success)
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Invalid arguments for tool ${definition.name}: ${z.prettifyError(parsed.error)}`
            }
          ]
        }
      const outcome = await definition.run(parsed.data, context, toolSignal(ctx))
      const meta = outcome.meta ? { _meta: outcome.meta } : {}
      if (!outcome.ok)
        return { isError: true, content: [{ type: 'text', text: outcome.text }], ...meta }
      const value = definition.output.parse(outcome.value) as Record<string, unknown>
      return {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
        ...meta
      }
    }
  }
}

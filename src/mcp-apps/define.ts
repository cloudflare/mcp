import type {
  CallToolResult,
  ServerContext,
  Tool,
  ToolAnnotations
} from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { AuthProps } from '../auth/types'
import { CLOUDFLARE_ICONS } from '../constants'
import type { Connection } from '../api-permissions'
import type { ScopeChallenge } from '../scope-challenge'
import type { StaticResource } from '../skills/handlers'
import { withCachedJsonSchema } from '../lib/isolate-json-schema'
import type { Tool as GeneratedTool } from '../generated/forge-mcp/_/tool'

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
  /**
   * Whether the client declared MCP Apps, so a view renders the result. Only
   * then may the result's text leave out what only the view shows
   * ({@link McpAppDefinition.modelText}); a text-only host has nothing else.
   */
  readonly view?: boolean
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
  /** The generated tools the App's view calls with `callServerTool`; see {@link McpAppDefinition.appTools}. */
  readonly appTools: readonly GeneratedTool[]
  /** Why the view may not make this call of one of its `appTools`; see {@link McpAppDefinition.appToolCheck}. */
  readonly appToolCheck?: (tool: string, args: Record<string, unknown>) => string | undefined
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
    /**
     * Ask the host to draw the frame (`_meta.ui.prefersBorder`): its border,
     * background and radius, so the view draws no ring of its own. Omitted, the
     * host decides.
     */
    readonly prefersBorder?: boolean
  }
  /**
   * Generated tools (such as `alerting_policies_create`, imported from its
   * group in `src/generated/forge-mcp`) the App's view calls with
   * `callServerTool` when the user clicks for a write. The direct tools
   * already list every one. Code Mode lists only these, with
   * `_meta.ui.visibility: ['app']` so the model never sees them, and serves
   * them through the forge tools service like the direct tools, so a write
   * needs no tool of its own. Import the group's `tools.ts`, never the index:
   * the index pulls in every generated tool.
   */
  readonly appTools?: readonly GeneratedTool[]
  /**
   * Why the view may not make this call of one of its `appTools`, or
   * `undefined` when it may. Code Mode runs it on the server before planning
   * the call, so what the view promises (such as D1 Studio's reads only)
   * holds whatever the view sends. The direct tools list the same generated
   * tools for the model, unchecked, under the Cloudflare policy as ever.
   */
  readonly appToolCheck?: (tool: string, args: Record<string, unknown>) => string | undefined
  /**
   * The result's text for a client that renders the view, which the model
   * reads and re-reads on every later turn. Defaults to the whole result as
   * JSON. An App whose view needs more than the model does (a chart's series)
   * returns a smaller JSON here: the view still gets the whole result as
   * `structuredContent`, validated against the output schema. A client
   * without Apps always gets the whole result as text, the spec's fallback.
   */
  readonly modelText?: (value: z.output<Output>) => string
  /** Collect the result. Reads must stop when `signal` aborts. */
  run(
    input: z.output<Input>,
    context: AppContext,
    signal: AbortSignal
  ): Promise<AppOutcome<z.output<Output>>>
}

/** zod's bounds for `.int()`, which say nothing a JSON number doesn't. */
const SAFE_INTEGER_BOUNDS = [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]

/**
 * An App's JSON Schema as clients list it, without what zod adds that no
 * client needs: the `$schema` URI, the regex it writes beside each
 * `format: date` and `date-time` (500 characters apiece, the same rule the
 * format names), and the safe-integer bounds of every `.int()`. About a
 * fifth of each App tool's listing (1.1 KB of 5.2 KB), sent on every
 * `tools/list`; the input schema's share also reaches the model with the
 * tool. The server still validates every argument and result with the zod
 * schema itself, so nothing is checked less.
 */
export function compactJsonSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(compactJsonSchema) as T
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  const node = schema as Record<string, unknown>
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema') continue
    if (key === 'pattern' && (node.format === 'date' || node.format === 'date-time')) continue
    if ((key === 'maximum' || key === 'minimum') && SAFE_INTEGER_BOUNDS.includes(value as number))
      continue
    out[key] = compactJsonSchema(value)
  }
  return out as T
}

function listedJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return compactJsonSchema(z.toJSONSchema(schema) as Record<string, unknown>)
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
  const { uri, name: resourceName, html, prefersBorder } = definition.resource
  const meta = { ui: { resourceUri: uri }, 'ui/resourceUri': uri }
  const tool: Tool = {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    annotations: definition.annotations,
    // The host draws the mark in its own chrome, so the view carries no logo.
    icons: CLOUDFLARE_ICONS,
    _meta: meta,
    inputSchema: listedJsonSchema(definition.input) as Tool['inputSchema'],
    outputSchema: listedJsonSchema(definition.output) as Tool['outputSchema']
  }
  const resource: StaticResource = {
    descriptor: { uri, name: resourceName, mimeType: MCP_APP_MIME },
    content: {
      uri,
      mimeType: MCP_APP_MIME,
      text: html,
      _meta: {
        ui: {
          csp: { connectDomains: [], resourceDomains: [] },
          ...(prefersBorder !== undefined && { prefersBorder })
        }
      }
    }
  }
  return {
    tool,
    resource,
    appTools: definition.appTools ?? [],
    ...(definition.appToolCheck && { appToolCheck: definition.appToolCheck }),
    inputSchema: withCachedJsonSchema(definition.input, compactJsonSchema),
    outputSchema: withCachedJsonSchema(definition.output, compactJsonSchema),
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
      const output = definition.output.parse(outcome.value)
      const value = output as Record<string, unknown>
      const text =
        context.view && definition.modelText ? definition.modelText(output) : JSON.stringify(value)
      return {
        content: [{ type: 'text', text }],
        structuredContent: value,
        ...meta
      }
    }
  }
}

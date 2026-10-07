/**
 * Contract for `mcp-tools.json`, the direct-tool catalogue the ToolsBuilder
 * container generates from Forge. The Worker serves it as-is: `tools/list`
 * returns each entry's protocol fields and `tools/call` uses `request` to
 * build the HTTP call. Nothing is derived from OpenAPI at request time.
 */

/** Where one argument goes on the wire, including OpenAPI serialization rules. */
export interface ParameterRoute {
  /** Wire name. */
  name: string
  /** Argument key in the tool's input. */
  key: string
  style: string
  explode: boolean
  allowReserved: boolean
  contentType?: string
}

export type JsonSchema = boolean | Record<string, unknown>

export interface McpToolInputSchema {
  $schema: 'https://json-schema.org/draft/2020-12/schema'
  type: 'object'
  properties: Record<string, JsonSchema>
  required: string[]
  $defs?: Record<string, JsonSchema>
  allOf?: JsonSchema[]
}

export interface McpToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  openWorldHint: true
}

/** One generated tool and the HTTP metadata needed to dispatch it. */
export interface McpTool {
  name: string
  title?: string
  description: string
  inputSchema: McpToolInputSchema
  annotations: McpToolAnnotations
  /**
   * Structured output for MCP 2026-07-28 clients: a shape hint every real
   * response satisfies (see scripts/generator/output.ts). Never sent to older
   * clients, whose outputSchema must have an object root.
   */
  outputSchema?: JsonSchema
  operationId?: string
  status?: string
  permissions: Record<string, unknown>
  request: {
    method: string
    path: string
    pathParams: ParameterRoute[]
    queryParams: ParameterRoute[]
    headerParams: ParameterRoute[]
    cookieParams: ParameterRoute[]
    body?: { contentType: string; content: Record<string, { encoding: Record<string, unknown> }> }
    /** `outputSchema` describes the envelope's `result`; send that as `structuredContent`. */
    unwrapResult?: boolean
  }
}

/**
 * A tool as stored in `mcp-tools.json`: `outputSchema` is an index into the
 * artifact's `outputSchemas`. Many operations share a response schema, so the
 * table stores each once and the Worker holds one object for all its users.
 */
export type McpToolEntry = Omit<McpTool, 'outputSchema'> & { outputSchema?: number }

export interface McpToolsArtifact {
  version: 2
  tools: McpToolEntry[]
  /** Distinct output schemas, referenced by index from `tools[].outputSchema`. */
  outputSchemas: JsonSchema[]
}

/** Store each distinct output schema once and point tools at it. */
export function packTools(tools: readonly McpTool[]): McpToolsArtifact {
  const indexes = new Map<string, number>()
  const outputSchemas: JsonSchema[] = []
  const entries = tools.map(({ outputSchema, ...tool }): McpToolEntry => {
    if (outputSchema === undefined) return tool
    const key = JSON.stringify(outputSchema)
    let index = indexes.get(key)
    if (index === undefined) {
      index = outputSchemas.push(outputSchema) - 1
      indexes.set(key, index)
    }
    return { ...tool, outputSchema: index }
  })
  return { version: 2, tools: entries, outputSchemas }
}

/** Resolve each tool's output schema index to the shared schema object. */
export function unpackTools({ tools, outputSchemas }: McpToolsArtifact): McpTool[] {
  return tools.map(({ outputSchema, ...tool }) => {
    if (outputSchema === undefined) return tool
    const schema = outputSchemas[outputSchema]
    if (schema === undefined)
      throw new Error(`${tool.name} names missing output schema ${outputSchema}`)
    return { ...tool, outputSchema: schema }
  })
}

/** Points direct-tool callers at the generated account listing tool. */
export const ACCOUNT_DISCOVERY_TOOL_GUIDANCE =
  'Call the accounts_list tool to discover available accounts.'

/** The `account_id` schema on every account-scoped tool, for every caller. */
export const ACCOUNT_ID_DESCRIPTION = `Cloudflare account ID. Optional when the session is authorized for exactly one account; otherwise required. ${ACCOUNT_DISCOVERY_TOOL_GUIDANCE}`

/** R2 keys written by each build. The Worker reads only these. */
export const SPEC_KEY = 'spec.json'
export const PRODUCTS_KEY = 'products.json'
export const MCP_TOOLS_KEY = 'mcp-tools.json'
export const ARTIFACT_KEYS = [SPEC_KEY, PRODUCTS_KEY, MCP_TOOLS_KEY] as const
export type ArtifactKey = (typeof ARTIFACT_KEYS)[number]

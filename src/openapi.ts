import { z } from 'zod'
import { NON_CODEMODE_ACCOUNT_DISCOVERY_GUIDANCE } from './auth/account-access'

/** R2 key of the direct-tool catalogue the scheduled handler writes. */
export const MCP_TOOLS_KEY = 'mcp-tools.json'

/**
 * Minimal shape of an OpenAPI operation, as stored in our pre-processed spec.
 */
export interface OperationInfo {
  summary?: string
  /** API token permissions the operation accepts; any one is enough. OAuth scopes share these names. */
  'x-api-token-group'?: string[]
  description?: string
  tags?: string[]
  parameters?: Array<{
    name: string
    in: string
    required?: boolean
    schema?: unknown
    description?: string
  }>
  requestBody?: {
    required?: boolean
    content?: Record<string, { schema?: unknown }>
  }
  responses?: Record<string, unknown>
}

/**
 * TypeScript declarations describing the `spec` object exposed to the `search`
 * tool's sandboxed code. Inlined into the search tool description.
 */
export const SPEC_TYPES = `
interface OperationInfo {
  summary?: string;
  "x-api-token-group"?: string[]; // API token permissions the endpoint accepts (any one); OAuth scopes have the same names
  description?: string;
  tags?: string[];
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown; description?: string }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
}

interface PathItem {
  get?: OperationInfo;
  post?: OperationInfo;
  put?: OperationInfo;
  patch?: OperationInfo;
  delete?: OperationInfo;
}

declare const spec: {
  paths: Record<string, PathItem>;
};
`

/**
 * Convert an OpenAPI path + method into a tool name.
 * e.g. GET /accounts/{account_id}/workers/scripts → get_accounts_workers_scripts
 */
export function pathToToolName(method: string, path: string): string {
  return `${method.toLowerCase()}_${pathToToolNameSuffix(path)}`
}

function pathToToolNameSuffix(path: string): string {
  let cleaned = path

  // Check if path ends with a {param} — keep it for disambiguation
  const trailingParam = cleaned.match(/\/\{([^}]+)\}$/)
  const suffix = trailingParam ? `_by_${trailingParam[1]}` : ''

  const name =
    cleaned
      .replace(/^\//, '')
      .replace(/\/\{[^}]+\}/g, '') // strip all {param} segments
      .replace(/\//g, '_')
      .replace(/[^a-z0-9_]/gi, '')
      .replace(/_+/g, '_')
      .replace(/_$/, '') + suffix

  // MCP spec: tool names SHOULD be between 1 and 128 characters
  return name.length > 128 ? name.slice(0, 128).replace(/_$/, '') : name
}

/**
 * Build a human-readable title for a non-Code-Mode tool from its
 * machine-friendly name. The title mirrors the tool name structure but with
 * each segment title-cased so clients can display consistent, readable labels.
 *
 * e.g. get_accounts_workers_scripts → Get Accounts Workers Scripts
 */
export function toolNameToTitle(name: string): string {
  const withPrepositions = name
    .replace(/_by_/g, ' by ')
    .replace(/_for_/g, ' for ')
    .replace(/_in_/g, ' in ')
    .replace(/_of_/g, ' of ')
    .replace(/_on_/g, ' on ')
    .replace(/_to_/g, ' to ')
    .replace(/_with_/g, ' with ')
  return withPrepositions.replace(/_/g, ' ').replace(/\b\w/g, (letter, offset) =>
    // Keep prepositions lower-case when preceded by a space and followed by a space/end.
    offset > 0 &&
    /\s/.test(withPrepositions[offset - 1] ?? '') &&
    ['by ', 'for ', 'in ', 'of ', 'on ', 'to ', 'with '].some((prep) =>
      withPrepositions.slice(offset).toLowerCase().startsWith(prep)
    )
      ? letter.toLowerCase()
      : letter.toUpperCase()
  )
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

export type HttpMethod = (typeof HTTP_METHODS)[number]

export type JsonObjectSchema = {
  $schema?: string
  type: 'object'
  properties: Record<string, { type: 'string'; description: string }>
  required?: string[]
}

/**
 * One entry of `mcp-tools.json`. The protocol fields are served to
 * `tools/list` as-is; routing fields feed the `tools/call` handler.
 */
export interface McpTool {
  name: string
  title?: string
  description: string
  inputSchema: JsonObjectSchema
  method: HttpMethod
  path: string
  queryParams: string[]
  headerParams: Array<{ name: string; key: string }>
  /** `x-api-token-group`: API token permissions the endpoint accepts; any one is enough. */
  permissions?: string[]
}

interface NonCodemodeOperation {
  toolName: string
  description: string
  method: HttpMethod
  path: string
  operation: OperationInfo
}

function listNonCodemodeOperations(
  paths: Record<string, Record<string, OperationInfo>>
): NonCodemodeOperation[] {
  const operations: NonCodemodeOperation[] = []
  const registeredNames = new Set<string>()

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method]
      if (!operation) continue

      let toolName = pathToToolName(method, path)
      // Deduplicate if truncation caused a collision
      if (registeredNames.has(toolName)) {
        let i = 2
        let candidate: string
        do {
          const suffixStr = `_${i}`
          const maxBase = 128 - suffixStr.length
          const base =
            toolName.length > maxBase ? toolName.slice(0, maxBase).replace(/_$/, '') : toolName
          candidate = `${base}${suffixStr}`
          i++
        } while (registeredNames.has(candidate))
        toolName = candidate
      }
      registeredNames.add(toolName)

      const description =
        `${method.toUpperCase()} ${path}` +
        (operation.summary ? `\n\n${operation.summary}` : '') +
        (operation.description ? `\n\n${operation.description}` : '')

      operations.push({ toolName, description, method, path, operation })
    }
  }

  return operations
}

/**
 * Build `mcp-tools.json` in the scheduled handler. This moves the full spec
 * walk, name de-duplication, descriptions, routing metadata and the final wire
 * JSON Schema (including the session-independent `account_id`) out of the
 * request path, so the Worker serves `tools/list` exactly as stored.
 */
export function buildMcpTools(paths: Record<string, Record<string, OperationInfo>>): McpTool[] {
  return listNonCodemodeOperations(paths).map(
    ({ toolName, description, method, path, operation }) => ({
      name: toolName,
      title: toolNameToTitle(toolName),
      description,
      inputSchema: withOptionalAccountId(buildJsonInputSchema(operation, path)),
      method,
      path,
      queryParams: (operation.parameters ?? [])
        .filter((parameter) => parameter.in === 'query')
        .map((parameter) => parameter.name),
      headerParams: (operation.parameters ?? [])
        .filter((parameter) => parameter.in === 'header')
        .map((parameter) => ({
          name: parameter.name,
          key: `header_${parameter.name.toLowerCase().replace(/-/g, '_')}`
        })),
      ...(operation['x-api-token-group'] ? { permissions: operation['x-api-token-group'] } : {})
    })
  )
}

export const ACCOUNT_ID_PARAM_DESCRIPTION = `Cloudflare account ID. Optional when the session is authorized for exactly one account; otherwise required. ${NON_CODEMODE_ACCOUNT_DISCOVERY_GUIDANCE}`

/**
 * The same `account_id` schema for every session: always present, never
 * required. MCP clients cache tool metadata and may serve one user's tool list
 * to another, so the schema can't depend on the token. The call handler fills
 * in the session's account when it can, and otherwise returns account
 * discovery guidance.
 */
function withOptionalAccountId(inputSchema: JsonObjectSchema): JsonObjectSchema {
  if (!inputSchema.properties['account_id']) return inputSchema

  const { required: currentRequired, ...rest } = inputSchema
  const properties = {
    ...inputSchema.properties,
    account_id: { type: 'string' as const, description: ACCOUNT_ID_PARAM_DESCRIPTION }
  }
  const required = currentRequired?.filter((name) => name !== 'account_id') ?? []
  return { ...rest, properties, ...(required.length > 0 ? { required } : {}) }
}

/** Rehydrate the small Zod shape required by the SDK's tools/call validation. */
export function zodInputSchemaFromJson(
  inputSchema: JsonObjectSchema
): Record<string, z.ZodTypeAny> {
  const required = new Set(inputSchema.required ?? [])
  return Object.fromEntries(
    Object.entries(inputSchema.properties).map(([name, property]) => {
      const schema = z.string().describe(property.description)
      return [name, required.has(name) ? schema : schema.optional()]
    })
  )
}

function buildJsonInputSchema(operation: OperationInfo, path: string): JsonObjectSchema {
  const properties: JsonObjectSchema['properties'] = {}
  const required = new Set<string>()
  const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])

  for (const name of pathParams) {
    const parameter = operation.parameters?.find((item) => item.name === name && item.in === 'path')
    properties[name] = {
      type: 'string',
      description: parameter?.description || `Path parameter: ${name}`
    }
    required.add(name)
  }

  for (const parameter of operation.parameters ?? []) {
    if (parameter.in === 'query') {
      properties[parameter.name] = {
        type: 'string',
        description: parameter.description || parameter.name
      }
      if (parameter.required) required.add(parameter.name)
    }

    if (parameter.in === 'header') {
      const key = `header_${parameter.name.toLowerCase().replace(/-/g, '_')}`
      properties[key] = {
        type: 'string',
        description: `Header: ${parameter.name}${parameter.description ? ` — ${parameter.description}` : ''}`
      }
      if (parameter.required) required.add(key)
    }
  }

  if (operation.requestBody) {
    properties['body'] = { type: 'string', description: 'Request body as string' }
    const contentTypes = Object.keys(operation.requestBody.content ?? {})
    if (contentTypes.some((contentType) => !contentType.includes('application/json'))) {
      properties['content_type'] = {
        type: 'string',
        description: `Content-Type header. Supported: ${contentTypes.join(', ')}`
      }
    }
  }

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties,
    ...(required.size > 0 ? { required: [...required] } : {})
  }
}

/**
 * Build a Zod input schema from OpenAPI operation parameters and requestBody.
 */
export function buildInputSchema(
  operation: OperationInfo,
  path: string
): Record<string, z.ZodTypeAny> {
  const schema: Record<string, z.ZodTypeAny> = {}

  // Extract path parameters from the path template
  const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])

  // Add path parameters
  for (const paramName of pathParams) {
    const paramSpec = operation.parameters?.find(
      (p: { name: string; in: string }) => p.name === paramName && p.in === 'path'
    )
    const desc = paramSpec?.description || `Path parameter: ${paramName}`
    schema[paramName] = z.string().describe(desc)
  }

  // Add query parameters
  if (operation.parameters) {
    for (const param of operation.parameters) {
      if (param.in === 'query') {
        const field = param.required
          ? z.string().describe(param.description || param.name)
          : z
              .string()
              .optional()
              .describe(param.description || param.name)
        schema[param.name] = field
      }
    }
  }

  // Add header parameters (e.g., If-Match for ETags)
  if (operation.parameters) {
    for (const param of operation.parameters) {
      if (param.in === 'header') {
        const headerKey = `header_${param.name.toLowerCase().replace(/-/g, '_')}`
        const field = param.required
          ? z
              .string()
              .describe(
                `Header: ${param.name}${param.description ? ` — ${param.description}` : ''}`
              )
          : z
              .string()
              .optional()
              .describe(
                `Header: ${param.name}${param.description ? ` — ${param.description}` : ''}`
              )
        schema[headerKey] = field
      }
    }
  }

  // Add body and content_type params if requestBody exists
  if (operation.requestBody) {
    const contentTypes = operation.requestBody.content
      ? Object.keys(operation.requestBody.content)
      : []
    const hasNonJson = contentTypes.some((ct) => !ct.includes('application/json'))

    schema['body'] = z.string().optional().describe('Request body as string')

    if (hasNonJson) {
      schema['content_type'] = z
        .string()
        .optional()
        .describe(`Content-Type header. Supported: ${contentTypes.join(', ')}`)
    }
  }

  return schema
}

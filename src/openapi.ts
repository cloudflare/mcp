import { z } from 'zod'

/**
 * Minimal shape of an OpenAPI operation, as stored in our pre-processed spec.
 */
export interface OperationInfo {
  summary?: string
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
  let cleaned = path

  // Check if path ends with a {param} — keep it for disambiguation
  const trailingParam = cleaned.match(/\/\{([^}]+)\}$/)
  const suffix = trailingParam ? `_by_${trailingParam[1]}` : ''

  const name =
    method.toLowerCase() +
    '_' +
    cleaned
      .replace(/^\//, '')
      .replace(/\/\{[^}]+\}/g, '') // strip all {param} segments
      .replace(/\//g, '_')
      .replace(/[^a-z0-9_]/gi, '')
      .replace(/_+/g, '_')
      .replace(/_$/, '') +
    suffix

  // MCP spec: tool names SHOULD be between 1 and 128 characters
  return name.length > 128 ? name.slice(0, 128).replace(/_$/, '') : name
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

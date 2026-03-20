import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createCodeExecutor, createSearchExecutor } from './executor'
import { truncateResponse } from './truncate'
import type { AuthProps } from './auth/types'

const CLOUDFLARE_TYPES = `
interface CloudflareRequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;  // Custom Content-Type header (defaults to application/json if body is present)
  rawBody?: boolean;     // If true, sends body as-is without JSON.stringify
}

interface CloudflareResponse<T = unknown> {
  success: boolean;
  status: number;
  result: T;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    count: number;
    total_count: number;
  };
}

declare const cloudflare: {
  request<T = unknown>(options: CloudflareRequestOptions): Promise<CloudflareResponse<T>>;
};

declare const accountId: string;
`

function cloudflareTypesForAccount(accountId: string | undefined, props?: AuthProps): string {
  // When accountId is known, tell the LLM it's pre-set
  if (accountId) {
    return (
      CLOUDFLARE_TYPES +
      `\n// accountId is pre-set to "${accountId}" — use it directly in API paths.\n`
    )
  }

  if (props?.type === 'user_token' && props.accounts.length === 1) {
    return (
      CLOUDFLARE_TYPES +
      `\n// accountId is pre-set to "${props.accounts[0].id}" (${props.accounts[0].name}) — use it directly in API paths.\n`
    )
  }

  // When multiple accounts, replace the `declare const accountId: string` with guidance
  if (props?.type === 'user_token' && props.accounts.length > 1) {
    const list = props.accounts.map((a) => `//   "${a.id}" — ${a.name}`).join('\n')
    // Remove the accountId declaration and add multi-account guidance
    const typesWithoutAccountId = CLOUDFLARE_TYPES.replace('declare const accountId: string;\n', '')
    return (
      typesWithoutAccountId +
      `\n// IMPORTANT: This token has access to multiple Cloudflare accounts.\n` +
      `// The accountId variable will be set based on the account_id parameter you pass to this tool.\n` +
      `// Available accounts:\n${list}\n` +
      `// Ask the user which account to use if unclear, then pass it as the account_id parameter.\n` +
      `declare const accountId: string; // Set from your account_id parameter\n`
    )
  }

  return CLOUDFLARE_TYPES
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const SPEC_TYPES = `
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

async function registerNonCodemodeTools(
  server: McpServer,
  env: Env,
  apiToken: string,
  accountId: string | undefined,
  props?: AuthProps
): Promise<void> {
  const obj = await env.SPEC_BUCKET.get('spec.json')
  if (!obj) throw new Error('spec.json not found in R2. Run the scheduled handler to populate it.')
  const spec = (await obj.json()) as { paths: Record<string, Record<string, OperationInfo>> }
  const apiBase = env.CLOUDFLARE_API_BASE
  const registeredNames = new Set<string>()

  const methods = ['get', 'post', 'put', 'patch', 'delete'] as const

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of methods) {
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

      const inputSchema = buildInputSchema(operation, path)

      // Add account_id to input schema if not already a path param and user has multiple accounts
      const needsAccountId =
        !accountId &&
        path.includes('{account_id}') &&
        props?.type === 'user_token' &&
        props.accounts.length > 1

      if (needsAccountId) {
        inputSchema['account_id'] = z
          .string()
          .describe('Cloudflare account ID. Required for multi-account tokens.')
      }

      server.registerTool(toolName, { description, inputSchema }, async (params) => {
        try {
          // Build the URL with path parameters substituted
          let resolvedPath = path
          const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
          for (const paramName of pathParams) {
            let value = params[paramName] as string | undefined

            // Auto-resolve account_id
            if (paramName === 'account_id' && !value) {
              if (accountId) {
                value = accountId
              } else if (props?.type === 'user_token' && props.accounts.length === 1) {
                value = props.accounts[0].id
              }
            }

            if (!value) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Error: missing required path parameter: ${paramName}`
                  }
                ],
                isError: true
              }
            }
            resolvedPath = resolvedPath.replace(`{${paramName}}`, encodeURIComponent(value))
          }

          // Build query string
          const url = new URL(apiBase + resolvedPath)
          if (operation.parameters) {
            for (const param of operation.parameters) {
              if (param.in === 'query' && params[param.name] !== undefined) {
                url.searchParams.set(param.name, String(params[param.name]))
              }
            }
          }

          // Build request
          const headers: Record<string, string> = {
            Authorization: `Bearer ${apiToken}`
          }

          // Add header parameters
          if (operation.parameters) {
            for (const param of operation.parameters) {
              if (param.in === 'header') {
                const headerKey = `header_${param.name.toLowerCase().replace(/-/g, '_')}`
                if (params[headerKey] !== undefined) {
                  headers[param.name] = String(params[headerKey])
                }
              }
            }
          }

          let requestBody: string | undefined
          if (params['body']) {
            headers['Content-Type'] = (params['content_type'] as string) || 'application/json'
            requestBody = params['body'] as string
          }

          const response = await fetch(url.toString(), {
            method: method.toUpperCase(),
            headers,
            body: requestBody
          })

          const contentType = response.headers.get('content-type') || ''
          let result: string

          if (contentType.includes('application/json')) {
            const data = await response.json()
            result = JSON.stringify(data, null, 2)
          } else {
            result = await response.text()
          }

          return {
            content: [{ type: 'text' as const, text: truncateResponse(result) }],
            isError: !response.ok
          }
        } catch (error) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: ${error instanceof Error ? error.message : String(error)}`
              }
            ],
            isError: true
          }
        }
      })
    }
  }
}

export async function createServer(
  env: Env,
  ctx: ExecutionContext,
  apiToken: string,
  accountId: string | undefined,
  props?: AuthProps,
  codemode = true
): Promise<McpServer> {
  // Build server instructions with account info for multi-account tokens
  let instructions: string | undefined
  if (!accountId && props?.type === 'user_token' && props.accounts.length > 1) {
    const list = props.accounts.map((a) => `  - ${a.id} (${a.name})`).join('\n')
    instructions =
      `This token has access to multiple Cloudflare accounts. ` +
      `Pass the account_id argument to tools that require it.\n\nAvailable accounts:\n${list}`
  }

  const server = new McpServer(
    { name: 'cloudflare-api', version: '0.1.0' },
    instructions ? { instructions } : undefined
  )

  if (!codemode) {
    await registerNonCodemodeTools(server, env, apiToken, accountId, props)
    return server
  }

  const executeCode = createCodeExecutor(env, ctx)
  const executeSearch = createSearchExecutor(env)

  const obj = await env.SPEC_BUCKET.get('products.json')
  const products: string[] = obj ? await obj.json() : []

  server.registerTool(
    'search',
    {
      description: `Search the Cloudflare OpenAPI spec. All $refs are pre-resolved inline.

Products: ${products.slice(0, 30).join(', ')}... (${products.length} total)

Types:
${SPEC_TYPES}

Examples:

// Find endpoints by product
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.tags?.some(t => t.toLowerCase() === 'workers')) {
        results.push({ method: method.toUpperCase(), path, summary: op.summary });
      }
    }
  }
  return results;
}

// Get endpoint with requestBody schema (refs are resolved)
async () => {
  const op = spec.paths['/accounts/{account_id}/d1/database']?.post;
  return { summary: op?.summary, requestBody: op?.requestBody };
}

// Get endpoint parameters
async () => {
  const op = spec.paths['/accounts/{account_id}/workers/scripts']?.get;
  return op?.parameters;
}`,
      inputSchema: {
        code: z.string().describe('JavaScript async arrow function to search the OpenAPI spec')
      }
    },
    async ({ code }) => {
      try {
        const result = await executeSearch(code)
        return { content: [{ type: 'text', text: truncateResponse(result) }] }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${formatError(error)}` }],
          isError: true
        }
      }
    }
  )

  const types = cloudflareTypesForAccount(accountId, props)

  const executeDescription = `Execute JavaScript code against the Cloudflare API. First use the 'search' tool to find the right endpoints, then write code using the cloudflare.request() function.

Available in your code:
${types}

Your code must be an async arrow function that returns the result.

Example: Worker with bindings (requires multipart/form-data):
async () => {
  const code = \`addEventListener('fetch', e => e.respondWith(MY_KV.get('key').then(v => new Response(v || 'none'))));\`;
  const metadata = { body_part: "script", bindings: [{ type: "kv_namespace", name: "MY_KV", namespace_id: "your-kv-id" }] };
  const b = \`--F\${Date.now()}\`;
  const body = [\`--\${b}\`, 'Content-Disposition: form-data; name="metadata"', 'Content-Type: application/json', '', JSON.stringify(metadata), \`--\${b}\`, 'Content-Disposition: form-data; name="script"', 'Content-Type: application/javascript', '', code, \`--\${b}--\`].join("\\r\\n");
  return cloudflare.request({ method: "PUT", path: \`/accounts/\${accountId}/workers/scripts/my-worker\`, body, contentType: \`multipart/form-data; boundary=\${b}\`, rawBody: true });
}`

  if (accountId) {
    // Account token mode: account_id is fixed, not a parameter
    server.registerTool(
      'execute',
      {
        description: executeDescription,
        inputSchema: {
          code: z.string().describe('JavaScript async arrow function to execute')
        }
      },
      async ({ code }) => {
        try {
          const result = await executeCode(code, accountId, apiToken)
          return { content: [{ type: 'text', text: truncateResponse(result) }] }
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Error: ${formatError(error)}` }],
            isError: true
          }
        }
      }
    )
  } else {
    // User token mode: account_id must be provided each time (or we show available accounts)
    server.registerTool(
      'execute',
      {
        description: executeDescription,
        inputSchema: {
          code: z.string().describe('JavaScript async arrow function to execute'),
          account_id: z
            .string()
            .optional()
            .describe(
              props?.type === 'user_token' && props.accounts.length > 1
                ? `Your Cloudflare account ID. Required — this token has access to multiple accounts: ${props.accounts.map((a) => `${a.id} (${a.name})`).join(', ')}`
                : 'Your Cloudflare account ID. Optional if you have only one account (will be auto-selected)'
            )
        }
      },
      async ({ code, account_id }) => {
        try {
          let effectiveAccountId: string

          if (account_id) {
            effectiveAccountId = account_id
          } else if (props?.type === 'user_token') {
            if (props.accounts.length === 1) {
              effectiveAccountId = props.accounts[0].id
            } else {
              const accountsList = props.accounts
                .map((acc) => `  - ${acc.id} (${acc.name})`)
                .join('\n')

              return {
                content: [
                  {
                    type: 'text',
                    text: `Error: Multiple accounts available. Please specify account_id parameter.\n\nAvailable accounts:\n${accountsList}`
                  }
                ],
                isError: true
              }
            }
          } else {
            return {
              content: [{ type: 'text', text: 'Error: account_id parameter is required' }],
              isError: true
            }
          }

          const result = await executeCode(code, effectiveAccountId, apiToken)
          return { content: [{ type: 'text', text: truncateResponse(result) }] }
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Error: ${formatError(error)}` }],
            isError: true
          }
        }
      }
    )
  }

  return server
}

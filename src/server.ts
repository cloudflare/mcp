import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { registerDocsTool } from './docs-search'
import { createCodeExecutor, createSearchExecutor } from './executor'
import { truncateResponse } from './truncate'
import { fetchWithRetry } from './utils/fetch-retry'
import { MetricsTracker, ToolCall } from './metrics'
import {
  accountTokenId,
  autoResolvedAccountId,
  inlineableAccounts,
  isMultiAccountUser,
  isSingleAccountUser
} from './auth/account-access'
import type { AuthProps } from './auth/types'

const SERVER_INFO = { name: 'cloudflare-api', version: '0.1.0' }

/**
 * Describe the optional `account_id` argument for user-token sessions.
 *
 * - Small, complete account lists are inlined so the model can pick directly.
 * - Otherwise (omitted large list or incomplete legacy list) we point the model
 *   at paginated `GET /accounts` for discovery.
 */
function accountIdParamDescription(props?: AuthProps): string {
  if (!isMultiAccountUser(props)) {
    return 'Your Cloudflare account ID. Optional if you have only one account (will be auto-selected)'
  }

  const accounts = inlineableAccounts(props)
  if (accounts) {
    const list = accounts.map((a) => `${a.id} (${a.name})`).join(', ')
    return `Your Cloudflare account ID. Required for account-scoped API calls. Available accounts: ${list}`
  }

  const countNote =
    props.accountCount !== undefined
      ? ` This token has access to ${props.accountCount} accounts.`
      : ''
  return `Your Cloudflare account ID. Required for account-scoped API calls.${countNote} Omit this argument and page through GET /accounts to discover them, or filter by exact name with GET /accounts?name=<exact account name>.`
}

/**
 * Resolve the userId to attribute metrics to. Only user tokens carry a user
 * identity; account tokens have no user, so blob3 is left undefined — matching
 * the other Cloudflare MCP servers (`props.type === 'user_token' ? ... : undefined`).
 */
function userIdFromProps(props?: AuthProps): string | undefined {
  return props?.type === 'user_token' ? props.user.id : undefined
}

/**
 * Wire Analytics Engine metrics into a server instance: log a `tool_call` for
 * every tool invocation (with an `errorCode` on failure). Monkey-patches
 * `registerTool` so every tool registered after this call is tracked
 * identically. Tolerant of a missing MCP_METRICS binding (becomes a no-op).
 *
 * Note: unlike the Durable-Object-backed Cloudflare MCP servers, this server is
 * stateless (a fresh McpServer per request), so there is no meaningful
 * `session_start` to log — `oninitialized` fires on a separate request from the
 * `initialize` handshake and can never see the client info. Client identity is
 * instead available at the HTTP layer via the User-Agent header.
 */
function attachMetrics(server: McpServer, env: Env, props?: AuthProps): void {
  const metrics = new MetricsTracker(env.MCP_METRICS, SERVER_INFO)
  const userId = userIdFromProps(props)

  const errorCodeOf = (e: unknown): number =>
    typeof (e as { code?: unknown })?.code === 'number' ? (e as { code: number }).code : -1

  // Our tool callbacks signal failure by returning `{ isError: true }` rather
  // than throwing, so inspect the resolved result as well as the thrown path.
  const logResult = (name: string, result: unknown) => {
    const errorCode = (result as { isError?: boolean })?.isError ? -1 : undefined
    metrics.logEvent(new ToolCall({ toolName: name, userId, errorCode }))
  }

  const originalRegisterTool = server.registerTool.bind(server) as (
    ...args: unknown[]
  ) => ReturnType<McpServer['registerTool']>

  server.registerTool = ((name: string, ...rest: unknown[]) => {
    const lastIndex = rest.length - 1
    const cb = rest[lastIndex] as (...cbArgs: unknown[]) => unknown
    rest[lastIndex] = (...cbArgs: unknown[]) => {
      try {
        const out = cb(...cbArgs)
        if (out instanceof Promise) {
          return out
            .then((r) => {
              logResult(name, r)
              return r
            })
            .catch((e: unknown) => {
              metrics.logEvent(new ToolCall({ toolName: name, userId, errorCode: errorCodeOf(e) }))
              throw e
            })
        }
        logResult(name, out)
        return out
      } catch (e) {
        metrics.logEvent(new ToolCall({ toolName: name, userId, errorCode: errorCodeOf(e) }))
        throw e
      }
    }
    return originalRegisterTool(name, ...rest)
  }) as McpServer['registerTool']
}

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

function cloudflareTypesForAccount(props?: AuthProps): string {
  // Single-account user token: name the account so the LLM can confirm it.
  if (isSingleAccountUser(props)) {
    return (
      CLOUDFLARE_TYPES +
      `\n// accountId is pre-set to "${props.accounts[0].id}" (${props.accounts[0].name}) — use it directly in API paths.\n`
    )
  }

  // Any other pinned account id (account-scoped token).
  const pinnedAccountId = autoResolvedAccountId(props)
  if (pinnedAccountId) {
    return (
      CLOUDFLARE_TYPES +
      `\n// accountId is pre-set to "${pinnedAccountId}" — use it directly in API paths.\n`
    )
  }

  if (isMultiAccountUser(props)) {
    return (
      CLOUDFLARE_TYPES +
      `\n// This token has access to multiple Cloudflare accounts.\n` +
      `// accountId is set from the account_id tool argument, or is empty when omitted.\n` +
      `// To discover account IDs, omit account_id and call GET /accounts with pagination.\n`
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
  // Account id resolvable without asking the user (account token or
  // single-account user token); undefined when the caller must choose.
  resolvedAccountId: string | undefined,
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

      // account_id is fully auto-resolved for account-token and single-account
      // user-token sessions, so drop it from the schema entirely — the handler
      // substitutes resolvedAccountId. Keeps hundreds of account-scoped tool
      // schemas lean and stops the model passing a value that can only be wrong.
      if (path.includes('{account_id}') && resolvedAccountId) {
        delete inputSchema['account_id']
      }

      // For multi-account user tokens account_id genuinely cannot be resolved,
      // so keep it required (buildInputSchema already added it) with a clearer
      // description.
      const needsAccountId =
        !resolvedAccountId && path.includes('{account_id}') && isMultiAccountUser(props)

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

            // Auto-resolve account_id from the token when not supplied.
            if (paramName === 'account_id' && !value) {
              value = resolvedAccountId
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

          const response = await fetchWithRetry(
            url.toString(),
            {
              method: method.toUpperCase(),
              headers,
              body: requestBody
            },
            { caller: 'non_codemode_tool_call' }
          )

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
  props: AuthProps,
  codemode = true
): Promise<McpServer> {
  const apiToken = props.accessToken
  // Account id usable without asking the user (account token, or single-account
  // user token); undefined when the model must choose per call.
  const resolvedAccountId = autoResolvedAccountId(props)

  const server = new McpServer(SERVER_INFO)

  // Track tool_call metrics for every tool registered below.
  attachMetrics(server, env, props)

  registerDocsTool(server, env)

  if (!codemode) {
    await registerNonCodemodeTools(server, env, apiToken, resolvedAccountId, props)
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

  const types = cloudflareTypesForAccount(props)

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

  const pinnedAccountId = accountTokenId(props)
  if (pinnedAccountId) {
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
          const result = await executeCode(code, pinnedAccountId, apiToken)
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
    // User token mode: account_id selects the account for account-scoped calls.
    // It may be omitted for account-independent discovery calls such as GET /accounts.
    server.registerTool(
      'execute',
      {
        description: executeDescription,
        inputSchema: {
          code: z.string().describe('JavaScript async arrow function to execute'),
          account_id: z.string().optional().describe(accountIdParamDescription(props))
        }
      },
      async ({ code, account_id }) => {
        try {
          // An empty accountId lets account-independent requests such as
          // GET /accounts run before the caller has selected an account.
          const effectiveAccountId = account_id || autoResolvedAccountId(props) || ''

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

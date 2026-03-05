import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { UrlElicitationRequiredError } from '@modelcontextprotocol/sdk/types.js'
import { getAgentByName } from 'agents'
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const SCOPES_DOCS_URL = 'https://developers.cloudflare.com/fundamentals/api/reference/permissions/'

const ELICITATION_MESSAGE =
  'This API call requires additional permissions. ' +
  'Open the link below to upgrade your scopes, then retry the operation.'

type ToolResult = { content: { type: 'text'; text: string }[]; isError: true }

/**
 * Compute a SHA-256 hash of the API token for use as a KV key.
 * This avoids storing the raw token in agent state.
 */
async function hashToken(token: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Check KV for a scope-upgraded token. Returns the upgraded token if available.
 */
async function getUpgradedToken(
  env: Env,
  tokenHash: string
): Promise<string | null> {
  const data = await env.OAUTH_KV.get(`token-upgrade:${tokenHash}`, 'json') as {
    accessToken: string
    refreshToken: string
    scopes: string[]
    timestamp: number
  } | null

  return data?.accessToken ?? null
}

interface ElicitationContext {
  server: McpServer
  env: Env
  baseUrl: string
  currentScopes?: string[]
  tokenHash: string
  userId?: string
}

/**
 * Handle 403 (insufficient scope) errors from the Cloudflare API.
 *
 * Creates an ElicitationAgent with a scope picker UI so the user can
 * upgrade their permissions without a full re-auth.
 *
 * - If the client supports URL elicitation: throws UrlElicitationRequiredError
 * - If the client does NOT support elicitation: returns a tool error result
 *   containing the scope upgrade URL
 * - If not a 403: returns undefined (caller should handle normally)
 */
export async function elicitUpdatedScopes(
  error: unknown,
  ctx?: ElicitationContext
): Promise<ToolResult | undefined> {
  if (!(error instanceof Error)) return undefined
  const status = (error as any).httpStatus
  if (status !== 403) return undefined

  const elicitationId = crypto.randomUUID()
  let callbackUrl = SCOPES_DOCS_URL

  // Create an ElicitationAgent with scope picker if the binding is available
  if (ctx?.env.ELICITATION_AGENT) {
    try {
      const stub = await getAgentByName(ctx.env.ELICITATION_AGENT, elicitationId)
      await stub.fetch(new Request('https://agent/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          errorMessage: error.message,
          currentScopes: ctx.currentScopes || [],
          tokenHash: ctx.tokenHash,
          userId: ctx.userId || 'unknown'
        })
      }))
      callbackUrl = `${ctx.baseUrl}/elicitation/${elicitationId}`
    } catch {
      // Fall back to static docs URL if agent creation fails
    }
  }

  const message = `${ELICITATION_MESSAGE}\n\n(${error.message})`

  // Check if the client supports URL elicitation
  const capabilities = ctx?.server.server.getClientCapabilities()
  if (capabilities?.elicitation?.url) {
    throw new UrlElicitationRequiredError([
      {
        mode: 'url',
        message,
        url: callbackUrl,
        elicitationId
      }
    ])
  }

  // Client does NOT support elicitation — return URL in tool error result
  return {
    content: [{ type: 'text', text: `${message}\n\nUpgrade permissions here: ${callbackUrl}` }],
    isError: true
  }
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

export async function createServer(
  env: Env,
  ctx: ExecutionContext,
  apiToken: string,
  accountId: string | undefined,
  props?: AuthProps,
  baseUrl?: string
): Promise<McpServer> {
  const server = new McpServer({
    name: 'cloudflare-api',
    version: '0.1.0'
  })

  const executeCode = createCodeExecutor(env, ctx)
  const executeSearch = createSearchExecutor(env)

  // Pre-compute token hash for scope upgrade lookups
  const tokenHash = await hashToken(apiToken)

  // Extract user context for elicitation
  const currentScopes = props?.type === 'user_token' ? props.scopes : undefined
  const userId = props?.type === 'user_token' ? props.user.id : undefined

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

  const executeDescription = `Execute JavaScript code against the Cloudflare API. First use the 'search' tool to find the right endpoints, then write code using the cloudflare.request() function.

Available in your code:
${CLOUDFLARE_TYPES}

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
          // Check for scope-upgraded token
          const effectiveToken = await getUpgradedToken(env, tokenHash) || apiToken
          const result = await executeCode(code, accountId, effectiveToken)
          return { content: [{ type: 'text', text: truncateResponse(result) }] }
        } catch (error) {
          const elicitation = await elicitUpdatedScopes(
            error,
            baseUrl ? { server, env, baseUrl, currentScopes, tokenHash, userId } : undefined
          )
          if (elicitation) return elicitation
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
              'Your Cloudflare account ID. Optional if you have only one account (will be auto-selected)'
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

          // Check for scope-upgraded token
          const effectiveToken = await getUpgradedToken(env, tokenHash) || apiToken
          const result = await executeCode(code, effectiveAccountId, effectiveToken)
          return { content: [{ type: 'text', text: truncateResponse(result) }] }
        } catch (error) {
          const elicitation = await elicitUpdatedScopes(
            error,
            baseUrl ? { server, env, baseUrl, currentScopes, tokenHash, userId } : undefined
          )
          if (elicitation) return elicitation
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

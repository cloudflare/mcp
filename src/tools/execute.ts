import { z } from 'zod'
import { env, exports, WorkerEntrypoint } from 'cloudflare:workers'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CLOUDFLARE_TYPES } from '../constants'
import { truncateResponse } from '../truncate'
import { fetchWithRetry } from '../utils/fetch-retry'
import { formatError } from '../utils/errors'
import {
  ACCOUNT_DISCOVERY_DESCRIPTION,
  ACCOUNT_DISCOVERY_GUIDANCE,
  accountTokenId,
  autoResolvedAccountId,
  inlineableAccounts,
  isMultiAccountUser,
  isSingleAccountUser
} from '../auth/account-access'
import type { AuthProps } from '../auth/types'

interface CodeExecutorEntrypoint {
  evaluate(): Promise<{ result: unknown; err?: string; stack?: string }>
}

type GlobalOutboundProps = { apiToken: string; fetchWithRetryCaller: string }

/**
 * Outbound fetch proxy for the `execute` isolate: restricts dynamically-loaded
 * worker code to the configured Cloudflare API base URL and injects the API
 * token from props (so it never enters the user code isolate).
 *
 * Bound as the `GLOBAL_OUTBOUND` worker-loader entrypoint in wrangler.jsonc and
 * passed to `LOADER.get(..).globalOutbound` below. Wrangler resolves the
 * entrypoint from the worker's entry module, so index.ts re-exports this class.
 */
export class GlobalOutbound extends WorkerEntrypoint<Env, GlobalOutboundProps> {
  async fetch(request: Request): Promise<Response> {
    const allowed = new URL(this.env.CLOUDFLARE_API_BASE).hostname
    const requested = new URL(request.url).hostname
    if (requested !== allowed) {
      return new Response(`Forbidden: requests to ${requested} are not allowed`, { status: 403 })
    }
    // Inject auth header — token comes from props, never enters user code isolate
    const authedRequest = new Request(request, {
      headers: new Headers([
        ...request.headers.entries(),
        ['Authorization', `Bearer ${this.ctx.props.apiToken}`]
      ])
    })
    return fetchWithRetry(authedRequest, undefined, {
      caller: this.ctx.props.fetchWithRetryCaller
    })
  }
}

/**
 * Run sandboxed JavaScript against the Cloudflare API via `cloudflare.request()`.
 *
 * A fresh isolate is created per call: the user code is baked into the module
 * source (dynamic-worker isolates disallow eval, so code cannot be passed into
 * a warm isolate), and the API token is injected via the GlobalOutbound props
 * so it never enters the user code isolate.
 */
async function runExecute(
  code: string,
  accountId: string | undefined,
  apiToken: string
): Promise<unknown> {
  const apiBase = env.CLOUDFLARE_API_BASE
  const workerId = `cloudflare-api-${crypto.randomUUID()}`

  // When no account is resolved (a multi-account user who hasn't chosen one),
  // don't bind a usable `accountId`. Account-independent calls (GET /accounts,
  // GET /user) never touch it, but any code that reads it fails fast with a
  // clear message instead of silently producing `/accounts//...` (a 404).
  const unresolvedAccountMessage = `No account selected: this token has access to multiple accounts. ${ACCOUNT_DISCOVERY_GUIDANCE}`
  const accountIdPrelude = accountId
    ? `const accountId = ${JSON.stringify(accountId)};`
    : `Object.defineProperty(globalThis, "accountId", { configurable: true, get() {
        throw new Error(${JSON.stringify(unresolvedAccountMessage)});
      } });`

  const worker = env.LOADER.get(workerId, () => ({
    compatibilityDate: '2026-01-12',
    globalOutbound: exports.GlobalOutbound({
      props: { apiToken, fetchWithRetryCaller: 'codemode_execute_tool_call' }
    }),
    mainModule: 'worker.js',
    modules: {
      'worker.js': `
import { WorkerEntrypoint } from "cloudflare:workers";

const apiBase = ${JSON.stringify(apiBase)};
${accountIdPrelude}

export default class CodeExecutor extends WorkerEntrypoint {
  async evaluate() {
    const cloudflare = {
      async request(options) {
        const { method, path, query, body, contentType, rawBody } = options;

        const url = new URL(apiBase + path);
        if (query) {
          for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
              url.searchParams.set(key, String(value));
            }
          }
        }

        const headers = {};

        if (contentType) {
          headers["Content-Type"] = contentType;
        } else if (body && !rawBody) {
          headers["Content-Type"] = "application/json";
        }

        let requestBody;
        if (rawBody) {
          requestBody = body;
        } else if (body) {
          requestBody = JSON.stringify(body);
        }

        const response = await fetch(url.toString(), {
          method,
          headers,
          body: requestBody,
        });

        const responseContentType = response.headers.get("content-type") || "";

        // Handle non-JSON responses (e.g., KV values)
        if (!responseContentType.includes("application/json")) {
          const text = await response.text();
          if (!response.ok) {
            throw new Error("Cloudflare API error: " + response.status + " " + text);
          }
          return { success: true, status: response.status, result: text };
        }

        const data = await response.json();

        // Handle GraphQL responses (different format than REST)
        const cleanPath = path.split('?')[0].replace(/\\/+$/, '');
        const isGraphQLEndpoint = cleanPath === '/graphql' || cleanPath.endsWith('/graphql');

        if (isGraphQLEndpoint) {
          const graphqlErrors = Array.isArray(data.errors) ? data.errors : [];
          const hasData = data.data !== null && data.data !== undefined;

          // Complete failure: no data, only errors
          if (graphqlErrors.length > 0 && !hasData) {
            const msgs = graphqlErrors.map(e => e.message).join(", ");
            throw new Error("GraphQL error: " + msgs);
          }

          // Success or partial success
          return {
            success: graphqlErrors.length === 0,
            status: response.status,
            result: data.data,
            errors: graphqlErrors.map(e => ({
              code: e.extensions?.code || 0,
              message: e.message + (e.path ? \` (at \${e.path.join('.')})\` : '')
            })),
            messages: graphqlErrors.length > 0 ? [{
              code: 0,
              message: \`Partial response: \${graphqlErrors.length} error(s)\`
            }] : []
          };
        }

        // Handle REST API responses
        if (!data.success) {
          const errorList = Array.isArray(data.errors) ? data.errors : [];
          const errors = errorList.map(e => e.code + ": " + e.message).join(", ");
          throw new Error("Cloudflare API error: " + (errors || response.status));
        }

        return { ...data, status: response.status };
      }
    };

    try {
      const result = await (${code})();
      return { result, err: undefined };
    } catch (err) {
      return { result: undefined, err: err.message, stack: err.stack };
    }
  }
}
      `
    }
  }))

  const entrypoint = worker.getEntrypoint() as unknown as CodeExecutorEntrypoint
  const response = await entrypoint.evaluate()

  if (response.err) {
    throw new Error(response.err)
  }

  return response.result
}

/**
 * The `CLOUDFLARE_TYPES` block plus a per-session comment describing how
 * `accountId` is resolved for this token (pinned, single account, or chosen
 * per call).
 */
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
      `\n// accountId is set from the optional account_id tool argument. Reading it before selecting an account throws an error.\n`
    )
  }

  return CLOUDFLARE_TYPES
}

/**
 * Description for the `execute` tool, including the per-session Cloudflare type
 * declarations and a multipart Worker-upload example.
 */
function executeToolDescription(props?: AuthProps): string {
  const types = cloudflareTypesForAccount(props)
  const accountSelection = accountSelectionDescription(props)

  return `Execute JavaScript code against the Cloudflare API. First use the 'search' tool to find the right endpoints, then write code using the cloudflare.request() function.

Available in your code:
${types}${accountSelection}

Your code must be an async arrow function that returns the result.

Example: Worker with bindings (requires multipart/form-data):
async () => {
  const code = \`addEventListener('fetch', e => e.respondWith(MY_KV.get('key').then(v => new Response(v || 'none'))));\`;
  const metadata = { body_part: "script", bindings: [{ type: "kv_namespace", name: "MY_KV", namespace_id: "your-kv-id" }] };
  const b = \`--F\${Date.now()}\`;
  const body = [\`--\${b}\`, 'Content-Disposition: form-data; name="metadata"', 'Content-Type: application/json', '', JSON.stringify(metadata), \`--\${b}\`, 'Content-Disposition: form-data; name="script"', 'Content-Type: application/javascript', '', code, \`--\${b}--\`].join("\\r\\n");
  return cloudflare.request({ method: "PUT", path: \`/accounts/\${accountId}/workers/scripts/my-worker\`, body, contentType: \`multipart/form-data; boundary=\${b}\`, rawBody: true });
}`
}

function accountSelectionDescription(props?: AuthProps): string {
  if (!isMultiAccountUser(props)) return ''

  const accounts = inlineableAccounts(props)
  if (accounts) {
    const list = accounts.map((account) => `- ${account.id} (${account.name})`).join('\n')
    return `

Available accounts:
${list}`
  }

  const access =
    props.accountCount !== undefined
      ? `This token has access to ${props.accountCount} Cloudflare accounts.`
      : 'This token has access to multiple Cloudflare accounts.'
  return `

${access} ${ACCOUNT_DISCOVERY_DESCRIPTION}`
}

function accountIdParamDescription(): string {
  return 'Cloudflare account ID to scope execution to a singular account. Optional for account-independent calls.'
}

/**
 * Register the `execute` tool: runs sandboxed JavaScript against the Cloudflare
 * API via `cloudflare.request()`.
 *
 * Two shapes depending on the session:
 *  - Account token (pinned account): `account_id` is fixed, not a parameter.
 *  - User token: `account_id` selects the account, and may be omitted for
 *    account-independent discovery calls such as `GET /accounts`.
 */
export function registerExecuteTool(server: McpServer, props: AuthProps): void {
  const apiToken = props.accessToken
  const description = executeToolDescription(props)
  const pinnedAccountId = accountTokenId(props)

  if (pinnedAccountId) {
    server.registerTool(
      'execute',
      {
        description,
        inputSchema: {
          code: z.string().describe('JavaScript async arrow function to execute')
        }
      },
      async ({ code }) => {
        try {
          const result = await runExecute(code, pinnedAccountId, apiToken)
          return { content: [{ type: 'text', text: truncateResponse(result) }] }
        } catch (error) {
          return formatError(error)
        }
      }
    )
    return
  }

  server.registerTool(
    'execute',
    {
      description,
      inputSchema: {
        code: z.string().describe('JavaScript async arrow function to execute'),
        account_id: z.string().optional().describe(accountIdParamDescription())
      }
    },
    async ({ code, account_id }) => {
      try {
        // Undefined accountId lets account-independent requests such as
        // GET /accounts run before the caller has selected an account; any
        // code that reads `accountId` then fails fast with a clear message.
        const effectiveAccountId = account_id || autoResolvedAccountId(props)

        const result = await runExecute(code, effectiveAccountId, apiToken)
        return { content: [{ type: 'text', text: truncateResponse(result) }] }
      } catch (error) {
        return formatError(error)
      }
    }
  )
}

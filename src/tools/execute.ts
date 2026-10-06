import { z } from 'zod'
import { env, exports, WorkerEntrypoint } from 'cloudflare:workers'
import type { McpServer } from '@modelcontextprotocol/server'
import { CLOUDFLARE_TYPES } from '../constants'
import type { FormatToolResult } from '../truncate'
import { fetchWithRetry } from '../utils/fetch-retry'
import { formatError } from '../utils/errors'
import { getSpec } from '../isolate-cache'
import type { ApiRequestObserver } from '../utils/api-request-observer'
import {
  CloudflareApiError,
  cloudflareApiErrorSchema,
  formatApiError,
  normalizedApiPath,
  readApiResponse,
  sanitizeApiDiagnostic,
  boundedApiHint
} from '../utils/cloudflare-api-errors'
import {
  ACCOUNT_DISCOVERY_DESCRIPTION,
  ACCOUNT_DISCOVERY_GUIDANCE,
  autoResolvedAccountId,
  missingAccountMessage,
  unknownAccountHint
} from '../auth/account-access'
import type { AuthProps } from '../auth/types'

const executeResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('success'), result: z.unknown() }),
  z.object({ kind: z.literal('api_failure'), diagnostic: cloudflareApiErrorSchema }),
  z.object({ kind: z.literal('javascript_failure'), message: z.string().max(2048) })
])

interface CodeExecutorEntrypoint {
  evaluate(): Promise<unknown>
}

type GlobalOutboundProps = {
  apiToken: string
  fetchWithRetryCaller: string
  pathTemplates: string[]
  observer?: ApiRequestObserver
  observerNonce?: string
}

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
    const pathTemplate = normalizedApiPath(
      new URL(request.url).pathname.slice(
        new URL(this.env.CLOUDFLARE_API_BASE).pathname.replace(/\/$/, '').length
      ),
      this.ctx.props.pathTemplates
    )
    const operation = {
      method: /^[A-Z]{1,16}$/.test(request.method) ? request.method : 'UNKNOWN',
      pathTemplate
    }
    const observer = this.ctx.props.observer
    const nonce = this.ctx.props.observerNonce
    const sequence =
      observer && nonce
        ? await observer.beginDispatch(nonce, operation.method, pathTemplate)
        : undefined
    if (observer && (sequence === null || sequence === undefined))
      throw new Error('API observer is unavailable')
    const response = await fetchWithRetry(authedRequest, undefined, {
      caller: this.ctx.props.fetchWithRetryCaller,
      logUrl: `${new URL(this.env.CLOUDFLARE_API_BASE).origin}${pathTemplate}`
    })
    // A lost observation after dispatch cannot undo or replace an API result.
    // Permission handling must suppress replay if completion history is unavailable.
    if (observer && nonce && sequence !== undefined && sequence !== null) {
      await observer.finishDispatch(nonce, sequence, response.status).catch(() => false)
    }
    const headers = new Headers(response.headers)
    // Never accept an upstream-supplied internal diagnostic marker.
    headers.delete('X-Cloudflare-MCP-API-Error')
    headers.set('X-Cloudflare-MCP-API-Path', pathTemplate)
    if (response.ok && !headers.get('content-type')?.includes('application/json')) {
      return new Response(response.body, { status: response.status, headers })
    }
    const parsed = await readApiResponse(response.clone(), operation, this.ctx.props.apiToken, true)
    if (parsed.kind === 'api_failure') {
      void response.body?.cancel().catch(() => {})
      headers.set('X-Cloudflare-MCP-API-Error', '1')
      headers.set('Content-Type', 'application/json')
      headers.delete('Content-Length')
      return new Response(JSON.stringify(parsed.diagnostic), { status: response.status, headers })
    }
    return new Response(response.body, { status: response.status, headers })
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
  apiToken: string,
  unresolvedAccountMessage: string
): Promise<unknown> {
  const apiBase = env.CLOUDFLARE_API_BASE
  const pathTemplates = await getSpec()
    .then((spec) => Object.keys(spec.paths))
    .catch(() => [])
  const workerId = `cloudflare-api-${crypto.randomUUID()}`

  // When no account is resolved (a multi-account user who hasn't chosen one),
  // don't bind a usable `accountId`. Account-independent calls (GET /accounts,
  // GET /user) never touch it, but any code that reads it fails fast with a
  // clear message instead of silently producing `/accounts//...` (a 404).
  const accountIdPrelude = accountId
    ? `const accountId = ${JSON.stringify(accountId)};`
    : `Object.defineProperty(globalThis, "accountId", { configurable: true, get() {
        throw new Error(${JSON.stringify(unresolvedAccountMessage)});
      } });`

  const worker = env.LOADER.get(workerId, () => ({
    compatibilityDate: '2026-01-12',
    globalOutbound: exports.GlobalOutbound({
      props: {
        apiToken,
        fetchWithRetryCaller: 'codemode_execute_tool_call',
        pathTemplates
      }
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
        if (response.headers.get("X-Cloudflare-MCP-API-Error") === "1") {
          const diagnostic = await response.json();
          const details = diagnostic.errors.map(e => (e.code === undefined ? "" : e.code + ": ") + e.message).join("; ");
          const error = new Error((diagnostic.kind === "graphql_error" ? "GraphQL error: " : "Cloudflare API error: ") +
            diagnostic.operation.method + " " + diagnostic.operation.pathTemplate + " returned HTTP " + diagnostic.upstreamStatus +
            (details ? " (" + details + ")" : ""));
          Object.assign(error, diagnostic, { status: diagnostic.upstreamStatus,
            method: diagnostic.operation.method, path: diagnostic.operation.pathTemplate,
            diagnostic });
          throw error;
        }
        // Successful non-JSON response formatting remains compatible.
        if (!responseContentType.includes("application/json")) {
          return { success: true, status: response.status, result: await response.text() };
        }
        let data;
        try { data = await response.json(); }
        catch {
          const diagnostic = { version: 1, kind: "invalid_api_response", upstreamStatus: response.status,
            operation: { method, pathTemplate: response.headers.get("X-Cloudflare-MCP-API-Path") || "/{redacted}" },
            errors: [], authorization: "unknown", retry: "do_not_retry_automatically" };
          const error = new Error("Cloudflare API returned malformed JSON");
          Object.assign(error, diagnostic, { diagnostic, status: response.status, method,
            path: diagnostic.operation.pathTemplate });
          throw error;
        }

        // A large successful HTTP body bypasses bounded host inspection.
        // Keep failure status/operation without copying its unbounded errors.
        if (data.success === false || (path.split('?')[0].replace(/\\/+$/, '') === '/graphql'
          && Array.isArray(data.errors) && data.errors.length > 0 && data.data == null)) {
          const diagnostic = { version: 1, kind: data.success === false ? "cloudflare_api_error" : "graphql_error",
            upstreamStatus: response.status,
            operation: { method, pathTemplate: response.headers.get("X-Cloudflare-MCP-API-Path") || "/{redacted}" },
            errors: [], authorization: "unknown", retry: "do_not_retry_automatically" };
          const error = new Error("Cloudflare API error: HTTP " + response.status);
          Object.assign(error, diagnostic, { diagnostic, status: response.status, method,
            path: diagnostic.operation.pathTemplate });
          throw error;
        }

        // Handle GraphQL responses (different format than REST)
        const cleanPath = path.split('?')[0].replace(/\\/+$/, '');
        const isGraphQLEndpoint = cleanPath === '/graphql' || cleanPath.endsWith('/graphql');

        if (isGraphQLEndpoint) {
          const graphqlErrors = Array.isArray(data.errors) ? data.errors : [];
          const hasData = data.data !== null && data.data !== undefined;

          // Success or partial success
          return {
            success: graphqlErrors.length === 0,
            status: response.status,
            result: data.data,
            errors: graphqlErrors.map(e => ({
              code: e.extensions?.code ?? 0,
              path: e.path,
              message: e.message + (e.path ? \` (at \${e.path.join('.')})\` : '')
            })),
            messages: graphqlErrors.length > 0 ? [{
              code: 0,
              message: \`Partial response: \${graphqlErrors.length} error(s)\`
            }] : []
          };
        }

        return { ...data, status: response.status };
      }
    };

    try {
      const result = await (${code})();
      return { kind: "success", result };
    } catch (err) {
      try {
        if (err?.diagnostic) return { kind: "api_failure", diagnostic: err.diagnostic };
        const message = typeof err === "string" ? err : err?.message;
        return { kind: "javascript_failure", message: typeof message === "string"
          ? message.slice(0, 2048) : "JavaScript threw a non-Error value" };
      } catch {
        return { kind: "javascript_failure", message: "JavaScript threw an unreadable value" };
      }
    }
  }
}
      `
    }
  }))

  const entrypoint = worker.getEntrypoint() as unknown as CodeExecutorEntrypoint
  const response = executeResultSchema.safeParse(await entrypoint.evaluate())
  if (!response.success) throw new Error('The code isolate returned an invalid result')
  if (response.data.kind === 'api_failure')
    throw new CloudflareApiError(
      sanitizeApiDiagnostic(response.data.diagnostic, pathTemplates, apiToken)
    )
  if (response.data.kind === 'javascript_failure') throw new Error(response.data.message)
  return response.data.result
}

/**
 * Description for the `execute` tool: the Cloudflare type declarations, how
 * `accountId` is resolved, and a multipart Worker-upload example.
 *
 * It is the same for every session. MCP clients cache tool metadata and may
 * serve one user's tool list to another, so nothing here may depend on the
 * token: no account ids or names, and no branching on token shape.
 */
const EXECUTE_TOOL_DESCRIPTION = `Execute JavaScript code that can read, create, update, or delete resources through the Cloudflare API. First use the 'search' tool to find the right endpoints, then write code using the cloudflare.request() function.

Available in your code:
${CLOUDFLARE_TYPES}
// accountId is the account_id tool argument when passed; otherwise the session's account when it is authorized for exactly one. Reading it when neither applies throws an error.

When the session has access to multiple accounts, pass account_id. ${ACCOUNT_DISCOVERY_DESCRIPTION}

Your code must be an async arrow function that returns the result.
Cloudflare API failures throw an error with status, method, path (a redacted route or catalog template), errors, requestId, retryAfterSeconds, and diagnostic properties. HTTP failure is independent of the REST success flag. GraphQL partial responses keep their data and errors. Uncaught API errors return bounded structured diagnostics; HTTP 401/403 alone does not prove a missing OAuth scope.

Example: Worker with bindings (requires multipart/form-data):
async () => {
  const code = \`addEventListener('fetch', e => e.respondWith(MY_KV.get('key').then(v => new Response(v || 'none'))));\`;
  const metadata = { body_part: "script", bindings: [{ type: "kv_namespace", name: "MY_KV", namespace_id: "your-kv-id" }] };
  const b = \`--F\${Date.now()}\`;
  const body = [\`--\${b}\`, 'Content-Disposition: form-data; name="metadata"', 'Content-Type: application/json', '', JSON.stringify(metadata), \`--\${b}\`, 'Content-Disposition: form-data; name="script"', 'Content-Type: application/javascript', '', code, \`--\${b}--\`].join("\\r\\n");
  return cloudflare.request({ method: "PUT", path: \`/accounts/\${accountId}/workers/scripts/my-worker\`, body, contentType: \`multipart/form-data; boundary=\${b}\`, rawBody: true });
}`

const ACCOUNT_ID_PARAM_DESCRIPTION =
  'Cloudflare account ID to run against. Optional when the session is authorized for exactly one account, and for account-independent calls such as GET /accounts.'

/**
 * Register the `execute` tool: runs sandboxed JavaScript against the Cloudflare
 * API via `cloudflare.request()`.
 *
 * The metadata is identical for every token (see `EXECUTE_TOOL_DESCRIPTION`);
 * only the handler looks at the session. An explicit `account_id` wins,
 * otherwise the account is auto-resolved for account tokens and single-account
 * user tokens. An account token given another account's id is rejected by the
 * Cloudflare API, the same as any other account it can't access.
 *
 * `formatResult` turns the value the code returns into the tool's text output.
 */
export function registerExecuteTool(
  server: McpServer,
  props: AuthProps,
  formatResult: FormatToolResult
): void {
  const apiToken = props.accessToken

  server.registerTool(
    'execute',
    {
      title: 'Cloudflare API Code Executor',
      description: EXECUTE_TOOL_DESCRIPTION,
      inputSchema: z.object({
        code: z.string().describe('JavaScript async arrow function to execute'),
        account_id: z.string().optional().describe(ACCOUNT_ID_PARAM_DESCRIPTION)
      }),
      annotations: {
        title: 'Cloudflare API Code Executor',
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true
      }
    },
    async ({ code, account_id }) => {
      try {
        // Undefined accountId lets account-independent requests such as
        // GET /accounts run before the caller has selected an account; any
        // code that reads `accountId` then fails fast with a clear message.
        const effectiveAccountId = account_id || autoResolvedAccountId(props)

        const result = await runExecute(
          code,
          effectiveAccountId,
          apiToken,
          missingAccountMessage(props, ACCOUNT_DISCOVERY_GUIDANCE)
        )
        return { content: [{ type: 'text', text: formatResult(result) }] }
      } catch (error) {
        const failure =
          error instanceof CloudflareApiError
            ? formatApiError(error.diagnostic)
            : formatError(error)
        const hint = account_id
          ? boundedApiHint(unknownAccountHint(props, account_id), apiToken)
          : ''
        if (hint) failure.content[0].text += `\n\n${hint}`
        return failure
      }
    }
  )
}

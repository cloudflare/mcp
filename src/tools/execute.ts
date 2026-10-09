import { z } from 'zod'
import { env, exports, WorkerEntrypoint } from 'cloudflare:workers'
import type { McpServer } from '@modelcontextprotocol/server'
import { CLOUDFLARE_TYPES } from '../constants'
import type { FormatToolResult } from '../truncate'
import { fetchWithRetry } from '../utils/fetch-retry'
import { formatError } from '../utils/errors'
import {
  ACCOUNT_DISCOVERY_DESCRIPTION,
  ACCOUNT_DISCOVERY_GUIDANCE,
  autoResolvedAccountId,
  missingAccountMessage,
  unknownAccountHint
} from '../auth/account-access'
import type { AuthProps } from '../auth/types'
import type { Connection } from '../api-permissions'
import { isCatalogScope } from '../api-permissions'
import {
  explainRefusedRequest,
  MISSING_SCOPE_HEADER,
  REFUSAL_HINT_HEADER
} from '../api-refusal-hint'
import { WWW_AUTHENTICATE_META_KEY, type ScopeChallenge } from '../scope-challenge'

interface CodeExecutorEntrypoint {
  evaluate(): Promise<unknown>
}

/** What the sandbox reports back. It is untrusted, so it is parsed. */
const Evaluation = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    message: z.string(),
    // The OAuth scope GlobalOutbound said the failing request lacked.
    missingScope: z.string().optional(),
    // Whether every request the code sent was a read or was refused, so rerunning repeats no change.
    replaySafe: z.boolean()
  })
])

/** The outcome of running the agent's code. */
type Execution = z.infer<typeof Evaluation>

type GlobalOutboundProps = {
  apiToken: string
  fetchWithRetryCaller: string
  connection: Connection
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
    const response = await fetchWithRetry(authedRequest, undefined, {
      caller: this.ctx.props.fetchWithRetryCaller
    })

    // Cloudflare's 401/403 bodies don't say why. Attach an explanation the
    // sandbox puts in the error it throws, so it survives the code catching it.
    const basePath = new URL(this.env.CLOUDFLARE_API_BASE).pathname.replace(/\/$/, '')
    const refusal = await explainRefusedRequest(
      response.status,
      this.ctx.props.connection,
      request.method,
      new URL(request.url).pathname.slice(basePath.length)
    )
    if (!refusal) return response
    const headers = new Headers(response.headers)
    headers.set(REFUSAL_HINT_HEADER, encodeURIComponent(refusal.hint))
    if (refusal.scope) headers.set(MISSING_SCOPE_HEADER, refusal.scope)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
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
  apiToken: string,
  unresolvedAccountMessage: string,
  connection: Connection
): Promise<Execution> {
  const apiBase = env.CLOUDFLARE_API_BASE
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
      props: { apiToken, fetchWithRetryCaller: 'codemode_execute_tool_call', connection }
    }),
    mainModule: 'worker.js',
    modules: {
      'worker.js': `
import { WorkerEntrypoint } from "cloudflare:workers";

const apiBase = ${JSON.stringify(apiBase)};
${accountIdPrelude}

// Every request the code sends, and the status it got. Replaying the code after a
// step-up is safe only if each one was a read or was refused.
const sentRequests = [];
const outboundFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const sent = { method: request.method.toUpperCase(), status: undefined };
  sentRequests.push(sent);
  const response = await outboundFetch(request);
  sent.status = response.status;
  return response;
};

// "Cloudflare API error: GET /zones/x/dns_records returned HTTP 403: 10000: Authentication error",
// plus the server's explanation of a 401/403.
function apiError(method, path, response, details) {
  const hint = response.headers.get(${JSON.stringify(REFUSAL_HINT_HEADER)});
  const error = new Error("Cloudflare API error: " + String(method).toUpperCase() + " " + path.split("?")[0] +
    " returned HTTP " + response.status + (details ? ": " + details.replace(/[. ]+$/, "") : "") +
    (hint ? ". " + decodeURIComponent(hint) : ""));
  const missingScope = response.headers.get(${JSON.stringify(MISSING_SCOPE_HEADER)});
  if (missingScope) error.missingScope = missingScope;
  return error;
}

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
            throw apiError(method, path, response, text.slice(0, 500));
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
          const errors = errorList.map(e => (e.code === undefined ? "" : e.code + ": ") + e.message +
            (e.documentation_url ? " (" + e.documentation_url + ")" : "")).join(", ");
          throw apiError(method, path, response, errors);
        }

        return { ...data, status: response.status };
      }
    };

    try {
      const result = await (${code})();
      return { ok: true, result };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        missingScope: typeof err?.missingScope === "string" ? err.missingScope : undefined,
        replaySafe: sentRequests.every(({ method, status }) =>
          method === "GET" || method === "HEAD" || status === 401 || status === 403)
      };
    }
  }
}
      `
    }
  }))

  const entrypoint = worker.getEntrypoint() as unknown as CodeExecutorEntrypoint
  const evaluation = Evaluation.safeParse(await entrypoint.evaluate())
  if (!evaluation.success) throw new Error('The code sandbox returned an unreadable result')
  return evaluation.data
}

const UNSAFE_TO_REPLAY =
  'Earlier requests in this program may already have changed resources, so it is not offered for an automatic retry. After the scope is granted, run only the steps that did not complete.'

/**
 * The scope to step up for when the code failed on a request refused for it.
 *
 * The sandbox reports the scope, so it is untrusted: it must be a catalog
 * scope the connection lacks. Code that lies can only ask for a scope it could
 * also get challenged for by calling an endpoint that needs it.
 */
function challengeableScope(execution: Execution, connection: Connection): string | undefined {
  if (execution.ok || connection.kind !== 'oauth' || !execution.missingScope) return undefined
  const scope = execution.missingScope
  return isCatalogScope(scope) && !connection.scopes.includes(scope) ? scope : undefined
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
A failed request throws an Error naming the method, path, HTTP status and Cloudflare's errors. For HTTP 401/403 it also says which permission the endpoint needs and whether reconnecting will help.

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
  formatResult: FormatToolResult,
  connection: Connection,
  scopeChallenge: ScopeChallenge
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

        const execution = await runExecute(
          code,
          effectiveAccountId,
          apiToken,
          missingAccountMessage(props, ACCOUNT_DISCOVERY_GUIDANCE),
          connection
        )
        if (execution.ok)
          return { content: [{ type: 'text', text: formatResult(execution.result) }] }

        const failure = formatError(execution.message)
        const hint = account_id ? unknownAccountHint(props, account_id) : ''
        if (hint) failure.content[0].text += `\n\n${hint}`
        const scope = challengeableScope(execution, connection)
        if (!scope) return failure
        if (!execution.replaySafe) {
          failure.content[0].text += `\n\n${UNSAFE_TO_REPLAY}`
          return failure
        }
        const challenge = scopeChallenge.require(scope)
        return challenge
          ? { ...failure, _meta: { [WWW_AUTHENTICATE_META_KEY]: [challenge] } }
          : failure
      } catch (error) {
        const failure = formatError(error)
        const hint = account_id ? unknownAccountHint(props, account_id) : ''
        if (hint) failure.content[0].text += `\n\n${hint}`
        return failure
      }
    }
  )
}

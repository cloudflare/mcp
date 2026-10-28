import { z } from 'zod'
import { withCachedJsonSchema } from '../lib/isolate-json-schema'
import { env, exports, WorkerEntrypoint } from 'cloudflare:workers'
import type { McpServer } from '@modelcontextprotocol/server'
import { CLOUDFLARE_TYPES } from '../constants'
import { formatterFor, TRUNCATE_ARGUMENT_DESCRIPTION } from '../truncate'
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
import { MISSING_SCOPE_HEADER, REFUSAL_HINT_HEADER, reviewResponse } from '../api-refusals'
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

    // Cloudflare's 401/403 bodies don't say why, and some lists come back empty
    // instead of refused. Report both as refusals with an explanation the
    // sandbox puts in the error it throws, so it survives the code catching it.
    const basePath = new URL(this.env.CLOUDFLARE_API_BASE).pathname.replace(/\/$/, '')
    return reviewResponse(
      response,
      this.ctx.props.connection,
      request.method,
      new URL(request.url).pathname.slice(basePath.length)
    )
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

// The media type of a Content-Type header, lower-cased, without parameters.
function mediaType(value) {
  return (value || "").split(";", 1)[0].trim().toLowerCase();
}

// application/json or any application/*+json. Not NDJSON or JSON Lines, whose
// bodies are lines of JSON rather than one value.
function isJsonType(type) {
  return /^application\\/(?:[\\w.-]+\\+)?json$/.test(type);
}

// Content read as text. An unlabelled response is text, as it always was, and
// so is multipart (a Worker's script); anything else unknown is kept as bytes.
const TEXT_TYPES = /^(?:text\\/|multipart\\/|message\\/)|^application\\/(?:xml|javascript|ecmascript|x-ndjson|jsonl|x-pem-file|x-www-form-urlencoded|graphql|sql|yaml|x-yaml|toml|csv)$|\\+xml$/;
function isTextType(contentType) {
  const type = mediaType(contentType);
  return type === "" || TEXT_TYPES.test(type) || /;\\s*charset=/i.test(contentType || "");
}

// Bodies fetch sends as they are.
function isRawBody(body) {
  return typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body) ||
    body instanceof Blob || body instanceof FormData || body instanceof URLSearchParams ||
    body instanceof ReadableStream;
}

function isJsonText(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// How cloudflare.request() sends a body. Objects, arrays, numbers and booleans
// go as JSON. Strings, bytes, Blob, FormData, URLSearchParams and streams go as
// they are, with contentType if given. The exception is a string sent as JSON
// (a JSON contentType, or none): one that is already JSON goes as it is, and
// any other is a JSON string value, such as Zaraz's "realtime".
function encodeBody(body, contentType, rawBody) {
  if (body === undefined || body === null) {
    return { requestBody: undefined, requestType: contentType };
  }
  const asJson = !contentType || isJsonType(mediaType(contentType));
  if (rawBody || (isRawBody(body) && !(typeof body === "string" && asJson))) {
    // FormData needs fetch's own multipart header, which carries the boundary.
    const withoutBoundary = body instanceof FormData && contentType && !/boundary=/i.test(contentType);
    return { requestBody: body, requestType: withoutBoundary ? undefined : contentType };
  }
  const json = typeof body === "string" && isJsonText(body) ? body : JSON.stringify(body);
  return { requestBody: json, requestType: contentType || "application/json" };
}

// The value the code returns, with bytes as { base64, byteLength } so they
// survive being rendered as JSON. Values without bytes are returned unchanged.
function encodeBytes(value, seen = new Set()) {
  if (value instanceof ArrayBuffer) value = new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return { base64: btoa(binary), byteLength: bytes.byteLength };
  }
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value;
  seen.add(value);
  let copy;
  for (const key of Object.keys(value)) {
    const encoded = encodeBytes(value[key], seen);
    if (encoded !== value[key]) {
      copy ??= Array.isArray(value) ? [...value] : { ...value };
      copy[key] = encoded;
    }
  }
  return copy ?? value;
}

export default class CodeExecutor extends WorkerEntrypoint {
  async evaluate() {
    const cloudflare = {
      async request(options) {
        // rawBody is no longer documented: the body's type decides how it is
        // sent. It is still honoured for code written against older descriptions.
        const { method, path, query, body, contentType, rawBody } = options;

        const url = new URL(apiBase + path);
        if (query) {
          for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
              url.searchParams.set(key, String(value));
            }
          }
        }

        const { requestBody, requestType } = encodeBody(body, contentType, rawBody);
        const headers = requestType ? { "Content-Type": requestType } : {};

        const response = await fetch(url.toString(), {
          method,
          headers,
          body: requestBody,
        });

        const responseType = mediaType(response.headers.get("content-type"));

        // Text comes back as a string, binary content (images, PDFs, archives,
        // application/octet-stream) as a Uint8Array, so it isn't corrupted by
        // decoding it as UTF-8.
        if (!isJsonType(responseType)) {
          if (!response.ok) {
            const text = await response.text();
            throw apiError(method, path, response, text.slice(0, 500));
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          const result = isTextType(response.headers.get("content-type"))
            ? new TextDecoder().decode(bytes)
            : bytes;
          return { success: true, status: response.status, result };
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

        // Some APIs (e.g., SQL and SCIM) return JSON without the REST envelope.
        const isEnvelope = data !== null && typeof data === "object"
          && !Array.isArray(data) && typeof data.success === "boolean";
        if (!response.ok || (isEnvelope && !data.success)) {
          const errorList = Array.isArray(data?.errors) ? data.errors : [];
          const errors = errorList.map(e => (e.code === undefined ? "" : e.code + ": ") + e.message +
            (e.documentation_url ? " (" + e.documentation_url + ")" : "")).join(", ");
          throw apiError(method, path, response, errors);
        }

        return isEnvelope
          ? { ...data, status: response.status }
          : { success: true, status: response.status, result: data };
      }
    };

    try {
      const result = await (${code})();
      return { ok: true, result: encodeBytes(result) };
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

Example: Worker with bindings (a multipart/form-data upload):
async () => {
  const code = \`export default { async fetch(request, env) { return new Response(await env.MY_KV.get('key') || 'none') } };\`;
  const metadata = { main_module: "worker.js", bindings: [{ type: "kv_namespace", name: "MY_KV", namespace_id: "your-kv-id" }] };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("worker.js", new Blob([code], { type: "application/javascript+module" }), "worker.js");
  return cloudflare.request({ method: "PUT", path: \`/accounts/\${accountId}/workers/scripts/my-worker\`, body: form });
}`

const ACCOUNT_ID_PARAM_DESCRIPTION =
  'Cloudflare account ID to run against. Optional when the session is authorized for exactly one account, and for account-independent calls such as GET /accounts.'

// Built once per isolate rather than for every request's server.
const ExecuteInputSchema = withCachedJsonSchema(
  z.object({
    code: z.string().describe('JavaScript async arrow function to execute'),
    account_id: z.string().optional().describe(ACCOUNT_ID_PARAM_DESCRIPTION),
    truncate: z.boolean().optional().describe(TRUNCATE_ARGUMENT_DESCRIPTION)
  })
)

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
 * The result is capped unless the call's `truncate` argument, or the
 * connection's `truncateByDefault` when it is omitted, is `false`.
 */
export function registerExecuteTool(
  server: McpServer,
  props: AuthProps,
  truncateByDefault: boolean,
  connection: Connection,
  scopeChallenge: ScopeChallenge
): void {
  const apiToken = props.accessToken

  server.registerTool(
    'execute',
    {
      title: 'Cloudflare API Code Executor',
      description: EXECUTE_TOOL_DESCRIPTION,
      inputSchema: ExecuteInputSchema,
      annotations: {
        title: 'Cloudflare API Code Executor',
        readOnlyHint: false,
        openWorldHint: true,
        destructiveHint: true
      }
    },
    async ({ code, account_id, truncate }) => {
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
        if (execution.ok) {
          const text = formatterFor(truncate, truncateByDefault)(execution.result)
          return { content: [{ type: 'text', text }] }
        }

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

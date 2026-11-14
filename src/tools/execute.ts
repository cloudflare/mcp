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
  unknownAccountHint,
  unknownPathAccountHint
} from '../auth/account-access'
import type { AuthProps } from '../auth/types'
import type { Connection } from '../api-permissions'
import { authorize, explainRefusal, isCatalogScope } from '../api-permissions'
import { MISSING_SCOPE_HEADER, REFUSAL_HINT_HEADER, reviewResponse } from '../api-refusals'
import { WWW_AUTHENTICATE_META_KEY, type ScopeChallenge } from '../scope-challenge'
import {
  getWaitBudgetMs,
  LONGEST_WAIT_MS,
  MOST_UNSENT_REQUESTS,
  NOT_SENT_HEADER,
  RATE_LIMIT_HEADER,
  withRateLimitNotice
} from '../rate-limit'
import { decodeBody, encodeBytes } from './response-body'

interface CodeExecutorEntrypoint {
  evaluate(): Promise<unknown>
}

/** What a run's rate limits did to it: requests refused, not sent, and time spent waiting. */
const RateLimitStats = z
  .object({ limited: z.number(), notSent: z.number(), waitedMs: z.number() })
  .optional()

/** What the sandbox reports back. It is untrusted, so it is parsed. */
const Evaluation = z.union([
  z.object({ ok: z.literal(true), result: z.unknown(), rateLimits: RateLimitStats }),
  z.object({
    ok: z.literal(false),
    rateLimits: RateLimitStats,
    message: z.string(),
    // The OAuth scope GlobalOutbound said the failing request lacked.
    missingScope: z.string().optional(),
    // The analytics permission a failed GraphQL query lacked, by dataset kind.
    graphqlRefusal: z.enum(['zone', 'account']).optional(),
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

    const basePath = new URL(this.env.CLOUDFLARE_API_BASE).pathname.replace(/\/$/, '')
    const path = new URL(request.url).pathname.slice(basePath.length)
    // What the response's rate limits ask of the run: the sandbox holds its
    // next requests back for it, and tells the agent about a 429.
    const noticed = await withRateLimitNotice(response, request.method, path)

    // Cloudflare's 401/403 bodies don't say why, and some lists come back empty
    // instead of refused. Report both as refusals with an explanation the
    // sandbox puts in the error it throws, so it survives the code catching it.
    return reviewResponse(noticed, this.ctx.props.connection, request.method, path)
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

// The holds Cloudflare's rate limits ask of this run: requests to wait before
// sending, by the method and path they cover, and until when. The server
// works each one out from a response (src/rate-limit.ts); this only applies
// them. A short hold is waited out, which paces a run that is close to a
// limit, until the run has waited its budget. Under a long one, after a 429,
// the request is answered here with a 429 and never sent: code that loops over hundreds of objects otherwise keeps
// sending, and every request is refused and counted against the limit.
const holds = new Map();
const rateLimitStats = { limited: 0, notSent: 0, waitedMs: 0 };
// When the last wait counted in waitedMs ends. Requests sent together wait out
// the same hold at the same time, which is one wait for the run, not one each.
let waitedUntil = 0;
const apiBasePath = new URL(apiBase).pathname.replace(/\\/$/, "");

// The hold on a request that ends last, if any.
function holdOn(method, path) {
  const now = Date.now();
  let latest;
  for (const [key, hold] of holds) {
    if (hold.until <= now) holds.delete(key);
    else if ((!hold.method || hold.method === method) && (!hold.pattern || hold.pattern.test(path)) &&
      (!latest || hold.until > latest.until)) latest = hold;
  }
  return latest;
}

function rememberHold(response) {
  if (response.status === 429) rateLimitStats.limited++;
  const header = response.headers.get(${JSON.stringify(RATE_LIMIT_HEADER)});
  if (!header) return;
  const { hold, method, pattern } = JSON.parse(decodeURIComponent(header));
  if (!hold) return;
  const key = (method || "*") + " " + (pattern || "*");
  const until = Date.now() + hold.waitMs;
  // A response that was in flight must not shorten the hold a 429 set.
  if (holds.has(key) && holds.get(key).until >= until) return;
  holds.set(key, { method, pattern: pattern ? new RegExp(pattern) : undefined, until, limit: hold.limit });
}

// The 429 for a request that was not sent, saying why and how long is left:
// Cloudflare refused an earlier request, or the run is out of time to pace.
function notSent({ limit, until }, outOfTime) {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  const named = limit ? ' (limit "' + limit + '")' : "";
  const message = outOfTime
    ? "This request was not sent: this code is close to Cloudflare's rate limit" + named +
      " and has already waited " + Math.round(rateLimitStats.waitedMs / 1000) +
      " seconds for it, the most one call waits. Send the remaining requests in another call, in " + seconds + " seconds or later."
    : "This request was not sent: Cloudflare rate limited an earlier request in this code" + named +
      " and asks to wait " + seconds +
      " more seconds. Do not send it again sooner: it will be refused again and count against the limit.";
  return new Response(JSON.stringify({ success: false, errors: [{ message }] }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(seconds), ${JSON.stringify(NOT_SENT_HEADER)}: "1" }
  });
}

// Stops the run: evaluate() returns this error whatever the code is doing.
// The code may still be running in other branches of a Promise.all, so from
// then on no request is sent or answered.
let stopRun;
let runIsStopped = false;
const runStopped = new Promise((resolve, reject) => { stopRun = reject; });
runStopped.catch(() => {});
const neverAnswered = () => new Promise(() => {});

// Answer a held request without sending it. The answer involves no I/O, so
// code that retries in a loop would spin until the Worker runs out of CPU or
// memory. Each answer therefore yields to the event loop, and past the most a
// run may have, the run is stopped and this request never answered.
async function answerUnsent(hold, outOfTime) {
  rateLimitStats.notSent++;
  const response = notSent(hold, outOfTime);
  if (rateLimitStats.notSent > ${MOST_UNSENT_REQUESTS}) {
    const { errors } = await response.json();
    runIsStopped = true;
    stopRun(new Error("This code was stopped: it kept sending requests after Cloudflare's rate limit held them back, and " +
      ${MOST_UNSENT_REQUESTS} + " requests were not sent. " + errors[0].message));
    return neverAnswered();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
}

const outboundFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const method = request.method.toUpperCase();
  const path = new URL(request.url).pathname.slice(apiBasePath.length);
  if (runIsStopped) return neverAnswered();
  for (let hold = holdOn(method, path); hold; hold = holdOn(method, path)) {
    const now = Date.now();
    const waitMs = hold.until - now;
    // The part of this wait the run is not already waiting out for another request.
    const addedMs = Math.max(0, hold.until - Math.max(now, waitedUntil));
    const outOfTime = rateLimitStats.waitedMs + addedMs > ${getWaitBudgetMs()};
    if (waitMs > ${LONGEST_WAIT_MS} || outOfTime) return answerUnsent(hold, waitMs <= ${LONGEST_WAIT_MS});
    rateLimitStats.waitedMs += addedMs;
    waitedUntil = Math.max(waitedUntil, hold.until);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (runIsStopped) return neverAnswered();
  }
  // The GraphQL Analytics API has no mutations, so its POSTs are reads too.
  const read = method === "GET" || method === "HEAD" || /\\/graphql\\/?$/.test(new URL(request.url).pathname);
  const sent = { read, status: undefined };
  sentRequests.push(sent);
  const response = await outboundFetch(request);
  sent.status = response.status;
  rememberHold(response);
  return response;
};

// "Cloudflare API error: GET /zones/x/dns_records returned HTTP 403 (Ray ID 8f...).",
// then the error body as the API sent it, then the server's explanation of a
// 401/403 or a 429. A request this sandbox answered itself is "not sent". The
// body is raw, so nothing the API says is lost, such as an error
// with a code but no message.
function apiError(method, path, response, body) {
  const hint = response.headers.get(${JSON.stringify(REFUSAL_HINT_HEADER)});
  const rateLimit = response.headers.get(${JSON.stringify(RATE_LIMIT_HEADER)});
  const ray = response.headers.get("cf-ray");
  const request = String(method).toUpperCase() + " " + path.split("?")[0];
  const notice = rateLimit ? JSON.parse(decodeURIComponent(rateLimit)) : {};
  const error = new Error([response.headers.has(${JSON.stringify(NOT_SENT_HEADER)})
      ? "Cloudflare API request not sent: " + request + "."
      : "Cloudflare API error: " + request + " returned HTTP " + response.status + (ray ? " (Ray ID " + ray + ")" : "") + ".",
    body, hint ? decodeURIComponent(hint) : "",
    notice.hint || ""].filter(Boolean).join("\\n\\n"));
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

const decodeBody = ${decodeBody};

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

const encodeBytes = ${encodeBytes};

// Which analytics permission a failed GraphQL query lacked. A zone dataset
// names it ("does not have permission 'com.cloudflare.api.account.zone.analytics.read'
// for zone ..."); an account dataset says only "authorization denied".
function graphqlRefusal(errors) {
  const messages = errors.map((e) => String(e.message || ""));
  if (messages.some((m) => m.includes("'com.cloudflare.api.account.zone.analytics.read'"))) return "zone";
  if (messages.some((m) => /^authorization denied$/i.test(m.trim()) || m.includes("'com.cloudflare.api.account.analytics.read'"))) return "account";
  return undefined;
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
        // anything that isn't valid UTF-8) as a Uint8Array, so it isn't
        // corrupted by decoding it as UTF-8.
        if (!isJsonType(responseType)) {
          if (!response.ok) {
            const text = await response.text();
            throw apiError(method, path, response, text.slice(0, 500));
          }
          return decodeBody(new Uint8Array(await response.arrayBuffer()), responseType);
        }

        const data = await response.json();

        // A GraphQL query that returned no data failed; partial data is
        // returned with its errors, as the API sends it.
        const cleanPath = path.split('?')[0].replace(/\\/+$/, '');
        if (cleanPath === '/graphql' || cleanPath.endsWith('/graphql')) {
          const graphqlErrors = Array.isArray(data?.errors) ? data.errors : [];
          if (graphqlErrors.length > 0 && (data.data === null || data.data === undefined)) {
            const error = new Error("GraphQL error: " + graphqlErrors.map(e => e.message).join(", "));
            error.graphqlRefusal = graphqlRefusal(graphqlErrors);
            throw error;
          }
          return data;
        }

        // A failed request throws; a successful one returns the body as the
        // API sends it, in Cloudflare's envelope or, for the few APIs without
        // it, bare.
        if (!response.ok || data?.success === false) {
          throw apiError(method, path, response, JSON.stringify(data, null, 2));
        }
        return data;
      }
    };

    try {
      const result = await Promise.race([(${code})(), runStopped]);
      return { ok: true, result: encodeBytes(result), rateLimits: rateLimitStats };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        missingScope: typeof err?.missingScope === "string" ? err.missingScope : undefined,
        graphqlRefusal: err?.graphqlRefusal === "zone" || err?.graphqlRefusal === "account" ? err.graphqlRefusal : undefined,
        replaySafe: sentRequests.every(({ read, status }) => read || status === 401 || status === 403),
        rateLimits: rateLimitStats
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
  logRateLimits(evaluation.data.rateLimits)
  return evaluation.data
}

/**
 * One log line for a run its rate limits touched, so their effect can be
 * measured in Workers Logs next to `fetchWithRetry: 429`: `limited` requests
 * Cloudflare refused, `not_sent` ones the hold saved, and the time spent pacing.
 */
function logRateLimits(stats: z.infer<typeof RateLimitStats>): void {
  if (!stats || (!stats.limited && !stats.notSent && !stats.waitedMs)) return
  console.log(
    `execute rate limits: limited=${stats.limited} not_sent=${stats.notSent} waited_ms=${Math.round(stats.waitedMs)}`
  )
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
function challengeableScope(
  scope: string | undefined,
  execution: Execution,
  connection: Connection
): string | undefined {
  if (execution.ok || connection.kind !== 'oauth' || !scope) return undefined
  return isCatalogScope(scope) && !connection.scopes.includes(scope) ? scope : undefined
}

/** The GraphQL Analytics API, which the spec doesn't list. */
const GRAPHQL_REQUEST = { method: 'POST', path: '/graphql' }

/** The permission each kind of GraphQL dataset needs. */
const GRAPHQL_PERMISSIONS = {
  zone: ['Analytics Read'],
  account: ['Account Analytics Read']
} as const

/**
 * The account in the path of the refused request a failure names, such as
 * `GET /accounts/<id>/workers/scripts returned HTTP 403`. The sandbox writes
 * the message, so the account is only used to look up a hint.
 */
function refusedAccountId(message: string): string | undefined {
  return /\/accounts\/([0-9a-f]{32})\b[^\n]* returned HTTP 40[13]\b/.exec(message)?.[1]
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
A failed request throws an Error naming the method, path, HTTP status and Cloudflare's errors. For HTTP 401/403 it also says which permission the endpoint needs and whether reconnecting will help. Requests slow down by themselves near a rate limit. For HTTP 429 the error says how long Cloudflare asks to wait; until then, requests under the same limit are not sent and throw too, so stop instead of catching and continuing.

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
        const pathAccount = account_id ? undefined : refusedAccountId(execution.message)
        const hint = account_id
          ? unknownAccountHint(props, account_id)
          : pathAccount
            ? unknownPathAccountHint(props, pathAccount)
            : ''
        if (hint) failure.content[0].text += `\n\n${hint}`
        const graphql = execution.graphqlRefusal
          ? authorize(connection, GRAPHQL_REQUEST, GRAPHQL_PERMISSIONS[execution.graphqlRefusal])
          : undefined
        if (graphql) failure.content[0].text += `\n\n${explainRefusal(403, graphql)}`
        const scope = challengeableScope(
          execution.missingScope ?? (graphql?.kind === 'missing' ? graphql.scope : undefined),
          execution,
          connection
        )
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

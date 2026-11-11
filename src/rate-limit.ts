import { findOperation } from './api-permissions'
import { getPermissionPaths } from './isolate-cache'
import { serverRetryDelayMs } from './utils/fetch-retry'

/**
 * Rate limits of the Cloudflare API, as its responses state them, and what
 * this server does about them.
 *
 * Each limit is a token bucket (measured against the API, see AGENTS.md):
 * `Ratelimit-Policy: "default";q=1200;w=300` is a bucket of 1,200 requests that
 * refills in 300 seconds, so 4 a second, and `Ratelimit: "default";r=1147;t=14`
 * says 1,147 are left and the bucket is full again in 14 seconds. An empty
 * bucket is a 429, and for the per-user limit a five-minute block of every API
 * call, the dashboard's included. So the aim is never to empty one:
 *
 * - {@link holdOf} turns a response into a hold: how long requests under the
 *   same limit should wait. Close to empty, long enough for the bucket to
 *   refill to its reserve (pacing). On a 429, as long as Cloudflare asks.
 * - `execute` applies holds inside one run (`src/tools/execute.ts`): it waits
 *   out a short hold and doesn't send a request under a long one.
 * - {@link rateLimitHint} tells the agent the wait, on every tool surface.
 *   Nothing is remembered between tool calls.
 */

/**
 * Response header `GlobalOutbound` sets for the `execute` sandbox: the
 * URI-encoded JSON of a {@link RateLimitNotice}.
 */
export const RATE_LIMIT_HEADER = 'X-Cloudflare-MCP-Rate-Limit'

/** Set on a 429 the sandbox answered itself, without sending the request. */
export const NOT_SENT_HEADER = 'X-Cloudflare-MCP-Not-Sent'

/**
 * The longest hold a run waits out, and so the longest pacing wait. Under a
 * longer one the request is not sent: a user is waiting on the tool call.
 */
export const LONGEST_WAIT_MS = 5_000

/** The share of a limit's quota kept unused, for the user's other clients and requests in flight. */
const RESERVE_SHARE = 0.05

/** The limit on a user's or account token's requests to every endpoint without its own. */
const SHARED_LIMIT = 'default'

/** One limit a response was counted under. */
export interface Limit {
  /** The limit's name, such as `default` or `rtwo_gw_apigw`. */
  readonly name: string
  /** Requests left in the bucket (`r`). */
  readonly remaining: number
  /** Seconds until the bucket is full again (`t`). */
  readonly refillSeconds: number
  /** The bucket's size (`q`) and the seconds it refills in (`w`), when the policy is sent. */
  readonly policy?: { readonly quota: number; readonly windowSeconds: number }
}

/** A structured-field list of `"name";key=number` items, by name. */
function items(header: string | null): Map<string, Record<string, number>> {
  const byName = new Map<string, Record<string, number>>()
  for (const item of (header ?? '').split(',')) {
    const name = /^\s*"([^"]*)"/.exec(item)?.[1]
    if (name === undefined) continue
    const values: Record<string, number> = {}
    for (const [, key, value] of item.matchAll(/;\s*([a-z]+)=(\d+)/g)) values[key!] = Number(value)
    byName.set(name, values)
  }
  return byName
}

/** The limits a response states in `Ratelimit`, with their `Ratelimit-Policy`. */
export function limitsOf(headers: Headers): Limit[] {
  const policies = items(headers.get('Ratelimit-Policy'))
  const limits: Limit[] = []
  for (const [name, { r, t }] of items(headers.get('Ratelimit'))) {
    if (r === undefined || t === undefined) continue
    const { q, w } = policies.get(name) ?? {}
    const policy = q && w ? { quota: q, windowSeconds: w } : undefined
    limits.push({ name, remaining: r, refillSeconds: t, policy })
  }
  return limits
}

/** How long requests under a limit should wait before the next one is sent. */
export interface Hold {
  /** The limit's name, when the response names it. */
  readonly limit?: string
  readonly waitMs: number
}

/** How long until `limit`'s bucket is back at its reserve, or 0 when it holds more. */
function pacingWaitMs({ remaining, policy }: Limit): number {
  if (!policy) return 0
  const reserve = Math.max(1, Math.ceil(policy.quota * RESERVE_SHARE))
  const secondsPerRequest = policy.windowSeconds / policy.quota
  return Math.max(0, reserve - remaining) * secondsPerRequest * 1000
}

/**
 * The hold a response asks for, if any.
 *
 * - A 429: as long as Cloudflare says, in `Retry-After` or the exhausted
 *   limit's `t`. A product's own 429 that gives no wait (D1, KV, URL Scanner)
 *   asks for none, and `fetchWithRetry` has already backed off for it.
 * - Any other response whose limit is below its reserve: until the bucket has
 *   refilled to it, at most {@link LONGEST_WAIT_MS}. A run then settles at the
 *   rate the bucket refills, 4 requests a second for the shared limit, without
 *   emptying it.
 */
export function holdOf(status: number, headers: Headers, now = Date.now()): Hold | undefined {
  const limits = limitsOf(headers)
  if (status === 429) {
    const waitMs = serverRetryDelayMs(headers, now)
    if (!waitMs) return undefined
    const exhausted = limits
      .filter((limit) => limit.remaining === 0)
      .sort((a, b) => b.refillSeconds - a.refillSeconds)[0]
    return { limit: exhausted?.name, waitMs }
  }
  let hold: Hold | undefined
  for (const limit of limits) {
    const waitMs = Math.min(pacingWaitMs(limit), LONGEST_WAIT_MS)
    if (waitMs > (hold?.waitMs ?? 0)) hold = { limit: limit.name, waitMs }
  }
  return hold
}

/**
 * What to tell the agent about a 429, or undefined for any other response.
 * The wait is in headers the agent never sees, so without this it calls again
 * at once and is refused again.
 */
export function rateLimitHint(
  status: number,
  headers: Headers,
  now = Date.now()
): string | undefined {
  if (status !== 429) return undefined
  const hold = holdOf(status, headers, now)
  const named = hold?.limit ? ` (limit "${hold.limit}")` : ''
  return hold
    ? `Cloudflare rate limited this request${named} and asks to wait ${Math.ceil(hold.waitMs / 1000)} seconds. Do not send it again sooner: it will be refused again and count against the limit.`
    : `Cloudflare rate limited this request${named} and did not say for how long. It was already retried with backoff, so wait before sending it again and send fewer requests at a time.`
}

/**
 * The requests a hold applies to: those with `method` whose path below the API
 * base matches `pattern`, or every request when neither is set.
 */
export interface HoldScope {
  readonly method?: string
  /** The source of an anchored regular expression. */
  readonly pattern?: string
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/**
 * The requests taken to share a limit with the request `method path`.
 *
 * A response names its limit but not the other endpoints under it, so nothing
 * is guessed: the shared limit covers every request, and any other limit
 * covers only the operation that reported it, on the same account or zone. A
 * limit that covers more costs one refused request per further operation.
 *
 * A parameter may hold slashes, as an R2 object key does, and then the path
 * has more segments than its template
 * (`/r2/buckets/{bucket_name}/objects/{object_name}`). So the operation is
 * the longest leading part of the path that is one ending in a parameter, and
 * its last parameter covers the rest of any path. A request the spec doesn't
 * list is only its own path.
 *
 * @param paths - The spec's operations by path template and method.
 * @param path - The request path below the API base.
 */
export function holdScope(
  limit: string | undefined,
  paths: Record<string, Record<string, unknown>> | undefined,
  method: string,
  path: string
): HoldScope {
  if (limit === SHARED_LIMIT) return {}
  const segments = path.replace(/\/+$/, '').split('/')
  const scoped = segments[1] === 'accounts' || segments[1] === 'zones'
  for (let length = segments.length; paths && length >= 2; length--) {
    const whole = length === segments.length
    const template = findOperation(paths, method, segments.slice(0, length).join('/'))?.template
    if (!template || (!whole && !template.endsWith('}'))) continue
    const parts = template.split('/').map((part, index) => {
      // The account or zone is the request's; every other parameter is any value.
      if (scoped && index <= 2) return escapeRegExp(segments[index]!)
      if (!/^\{[^}]+\}$/.test(part)) return escapeRegExp(part)
      return index === length - 1 ? '.+' : '[^/]+'
    })
    return { method: method.toUpperCase(), pattern: `^${parts.join('\\/')}\\/?$` }
  }
  return { method: method.toUpperCase(), pattern: `^${escapeRegExp(segments.join('/'))}\\/?$` }
}

/** What `GlobalOutbound` tells the `execute` sandbox about a response's rate limits. */
export interface RateLimitNotice extends HoldScope {
  /** The hold to apply to the requests in scope. */
  readonly hold?: Hold
  /** What to tell the agent, on a 429. */
  readonly hint?: string
}

/**
 * `response` with its {@link RateLimitNotice} in {@link RATE_LIMIT_HEADER},
 * when it asks for a hold or is a 429. The spec is looked up only for a hold
 * under a limit other than the shared one.
 */
export async function withRateLimitNotice(
  response: Response,
  method: string,
  path: string
): Promise<Response> {
  const hold = holdOf(response.status, response.headers)
  const hint = rateLimitHint(response.status, response.headers)
  if (!hold && !hint) return response
  const paths =
    hold && hold.limit !== SHARED_LIMIT
      ? await getPermissionPaths().catch(() => undefined)
      : undefined
  const notice: RateLimitNotice = {
    ...(hold ? holdScope(hold.limit, paths, method, path) : {}),
    hold,
    hint
  }
  const headers = new Headers(response.headers)
  headers.set(RATE_LIMIT_HEADER, encodeURIComponent(JSON.stringify(notice)))
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

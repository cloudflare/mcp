import { serverRetryDelayMs } from './utils/fetch-retry'

/**
 * Response header `GlobalOutbound` sets on a 429 for the `execute` sandbox: the
 * URI-encoded JSON of a {@link RateLimited}, so the sandbox can stop sending
 * requests Cloudflare would only refuse again.
 */
export const RATE_LIMIT_HEADER = 'X-Cloudflare-MCP-Rate-Limit'

/** Set on a 429 the sandbox answered itself, without sending the request. */
export const NOT_SENT_HEADER = 'X-Cloudflare-MCP-Not-Sent'

/** The limit the Cloudflare API names for its global per-user quota (1,200 requests per 5 minutes). */
const GLOBAL_LIMIT = 'default'

/** What a 429 from the Cloudflare API says about the limit it hit. */
export interface RateLimited {
  /** The exhausted limit's name from the `Ratelimit` header, such as `rtwo_gw_apigw`. */
  readonly limit?: string
  /** How long Cloudflare asks to wait, from `Retry-After` or the `Ratelimit` reset. */
  readonly waitMs?: number
  /** Whether the limit covers every endpoint, not only the one called. */
  readonly everyEndpoint: boolean
  /** What to tell the agent. */
  readonly hint: string
}

/** The name of the exhausted (`r=0`) `Ratelimit` item that resets last: `"default";r=0;t=30`. */
function exhaustedLimit(headers: Headers): string | undefined {
  let name: string | undefined
  let longest = -1
  for (const item of (headers.get('Ratelimit') ?? '').split(',')) {
    const reset = /;\s*t=(\d+)/.exec(item)?.[1]
    if (/;\s*r=(\d+)/.exec(item)?.[1] !== '0' || reset === undefined) continue
    if (Number(reset) > longest) {
      longest = Number(reset)
      name = /^\s*"([^"]*)"/.exec(item)?.[1]
    }
  }
  return name
}

/**
 * What a rate-limited response says, or undefined when `response` is not a 429.
 *
 * The hint tells the agent how long to wait. Without it an agent sees only
 * "HTTP 429" and calls again at once, which Cloudflare refuses again: nothing
 * here remembers a limit between tool calls.
 */
export function rateLimited(response: Response, now = Date.now()): RateLimited | undefined {
  if (response.status !== 429) return undefined
  const waitMs = serverRetryDelayMs(response.headers, now)
  const limit = exhaustedLimit(response.headers)
  const named = limit ? ` (limit "${limit}")` : ''
  const hint =
    waitMs === undefined
      ? `Cloudflare rate limited this request${named} and did not say for how long. It was already retried with backoff, so wait before sending it again and send fewer requests at a time.`
      : `Cloudflare rate limited this request${named} and asks to wait ${Math.ceil(waitMs / 1000)} seconds. Do not send it again sooner: it will be refused again and count against the limit.`
  return { limit, waitMs, everyEndpoint: limit === GLOBAL_LIMIT, hint }
}

/** `response` with what {@link rateLimited} says about it in {@link RATE_LIMIT_HEADER}, when it is a 429. */
export function withRateLimitHeader(response: Response): Response {
  const limited = rateLimited(response)
  if (!limited) return response
  const headers = new Headers(response.headers)
  headers.set(RATE_LIMIT_HEADER, encodeURIComponent(JSON.stringify(limited)))
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

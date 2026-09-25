import { USER_AGENT } from '../constants'

export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  backoffFactor?: number
  /**
   * Longest single wait. Caps the backoff, and a server asking for longer isn't retried: sooner
   * would only be another 429, so the caller gets it at once with the server's Retry-After.
   */
  maxDelayMs?: number
  jitter?: boolean
  caller?: string
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'caller'>> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  backoffFactor: 2,
  // A user waits on these calls: a few seconds slower beats a failure, but a longer server-given
  // wait is worse than failing fast with the server's Retry-After.
  maxDelayMs: 5_000,
  jitter: true
}

/**
 * How long the server asked us to wait, in ms: `Retry-After` (seconds or an HTTP date), or else
 * the reset time `t` of an exhausted (`r=0`) item in the Cloudflare API's `Ratelimit` header
 * (`"default";r=0;t=30`). Undefined when the response says nothing usable.
 */
export function serverRetryDelayMs(headers: Headers, now = Date.now()): number | undefined {
  const retryAfter = headers.get('Retry-After')?.trim()
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000
    // An HTTP date always has letters (`Wed, 21 Oct 2015 07:28:00 GMT`); `-1` would parse as a year.
    const date = /[a-z]/i.test(retryAfter) ? Date.parse(retryAfter) : Number.NaN
    if (!Number.isNaN(date)) return Math.max(0, date - now)
  }
  let resetMs: number | undefined
  for (const item of (headers.get('Ratelimit') ?? '').split(',')) {
    const remaining = /;\s*r=(\d+)/.exec(item)?.[1]
    const reset = /;\s*t=(\d+)/.exec(item)?.[1]
    if (remaining === '0' && reset !== undefined)
      resetMs = Math.max(resetMs ?? 0, Number(reset) * 1000)
  }
  return resetMs
}

/**
 * The wait before retry `attempt` (0-based). A server-given wait is honoured exactly when it fits
 * `maxDelayMs`; when it doesn't, this returns undefined: don't retry, the answer would be another
 * 429. Without one, exponential backoff with optional jitter.
 */
export function computeRetryDelay(
  attempt: number,
  opts: Required<Omit<RetryOptions, 'caller'>>
): number
export function computeRetryDelay(
  attempt: number,
  opts: Required<Omit<RetryOptions, 'caller'>>,
  serverDelayMs: number | undefined
): number | undefined
export function computeRetryDelay(
  attempt: number,
  opts: Required<Omit<RetryOptions, 'caller'>>,
  serverDelayMs?: number
): number | undefined {
  if (serverDelayMs !== undefined) {
    return serverDelayMs <= opts.maxDelayMs ? serverDelayMs : undefined
  }

  const exponentialDelay = opts.baseDelayMs * opts.backoffFactor ** attempt
  const capped = Math.min(exponentialDelay, opts.maxDelayMs)

  if (!opts.jitter) return capped

  return capped * (0.5 + Math.random() * 0.5)
}

export async function fetchWithRetry(
  input: RequestInfo,
  init?: RequestInit,
  options?: RetryOptions
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const url = typeof input === 'string' ? input : input.url
  const caller = options?.caller ? ` caller=${options.caller}` : ''

  let lastResponse: Response | undefined
  let lastError: unknown

  // Inject User-Agent so Cloudflare can identify traffic from this server.
  // When input is a Request, clone it to preserve its headers alongside the new header.
  // When input is a string/URL, merge into init.headers as a plain object.
  let fetchInput: RequestInfo
  let fetchInit: RequestInit | undefined
  if (input instanceof Request) {
    const headers = new Headers(input.headers)
    headers.set('User-Agent', USER_AGENT)
    fetchInput = new Request(input, { headers })
    fetchInit = init
  } else {
    fetchInput = input
    // Spread existing headers as a plain object to preserve casing, then set User-Agent last
    // so it always takes precedence over any caller-supplied value.
    const existingHeaders =
      init?.headers instanceof Headers
        ? Object.fromEntries(init.headers)
        : ((init?.headers as Record<string, string> | undefined) ?? {})
    fetchInit = {
      ...init,
      headers: { ...existingHeaders, 'User-Agent': USER_AGENT }
    }
  }

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const response = await fetch(fetchInput, fetchInit)

      if (response.status !== 429) {
        return response
      }

      lastResponse = response

      if (attempt < opts.maxRetries) {
        const serverDelay = serverRetryDelayMs(response.headers)
        const delay = computeRetryDelay(attempt, opts, serverDelay)
        const hints = rateLimitHints(response.headers)
        if (delay === undefined) {
          // Retrying before the server said to would only spend the same quota on another 429.
          console.warn(
            `fetchWithRetry: 429${caller} url=${url} on attempt ${attempt + 1}/${opts.maxRetries + 1}, ` +
              `not retrying: the server asks for ${Math.ceil(serverDelay! / 1000)}s${hints}`
          )
          return response
        }
        console.warn(
          `fetchWithRetry: 429${caller} url=${url} on attempt ${attempt + 1}/${opts.maxRetries + 1}, ` +
            `retrying in ${Math.round(delay)}ms${hints}`
        )
        await sleep(delay)
      }
    } catch (error) {
      lastError = error

      if (attempt < opts.maxRetries) {
        const delay = computeRetryDelay(attempt, opts)
        console.warn(
          `fetchWithRetry: network error${caller} url=${url} on attempt ${attempt + 1}/${opts.maxRetries + 1}, ` +
            `retrying in ${Math.round(delay)}ms: ${error instanceof Error ? error.message : error}`
        )
        await sleep(delay)
      }
    }
  }

  if (lastResponse) {
    console.error(
      `fetchWithRetry: failed${caller} url=${url} after ${opts.maxRetries + 1} attempts with status ${lastResponse.status}`
    )
    return lastResponse
  }

  console.error(
    `fetchWithRetry: failed${caller} url=${url} after ${opts.maxRetries + 1} attempts`,
    lastError
  )
  throw lastError
}

/** The raw rate-limit headers, for the log: what the API actually sends on a 429. */
function rateLimitHints(headers: Headers): string {
  const retryAfter = headers.get('Retry-After')
  const ratelimit = headers.get('Ratelimit')
  return (
    (retryAfter === null ? '' : ` retry-after=${retryAfter}`) +
    (ratelimit === null ? '' : ` ratelimit=${ratelimit}`)
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number
  /** Base delay in ms before first retry (default: 1000) */
  baseDelayMs?: number
  /** Multiplier applied to delay after each retry (default: 2) */
  backoffFactor?: number
  /** Maximum delay cap in ms (default: 5000) */
  maxDelayMs?: number
  /** Add random jitter to prevent thundering herd (default: true) */
  jitter?: boolean
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  backoffFactor: 2,
  maxDelayMs: 5_000, // Keep low — Workers have a 30s wall clock limit
  jitter: true
}

/**
 * Compute the delay before the next retry attempt.
 *
 * Uses exponential backoff with optional jitter:
 *   delay = min(baseDelay * factor^attempt, maxDelay)
 *   if jitter: delay *= random(0.5, 1.0)
 */
export function computeRetryDelay(
  attempt: number,
  opts: Required<RetryOptions>,
  retryAfterHeader?: string | null
): number {
  // Respect Retry-After header if present (value in seconds)
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader)
    if (!Number.isNaN(seconds) && seconds > 0) {
      // Still cap it so a misbehaving server can't stall us forever
      return Math.min(seconds * 1000, opts.maxDelayMs)
    }
  }

  const exponentialDelay = opts.baseDelayMs * opts.backoffFactor ** attempt
  const capped = Math.min(exponentialDelay, opts.maxDelayMs)

  if (!opts.jitter) return capped

  // Jitter between 50% and 100% of the computed delay
  return capped * (0.5 + Math.random() * 0.5)
}

/**
 * Fetch with automatic retries on HTTP 429 (Too Many Requests).
 *
 * All other status codes are returned immediately without retrying.
 * Network errors (fetch throws) are also retried.
 */
export async function fetchWithRetry(
  input: RequestInfo,
  init?: RequestInit,
  options?: RetryOptions
): Promise<Response> {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  let lastResponse: Response | undefined
  let lastError: unknown

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const response = await fetch(input, init)

      if (response.status !== 429) {
        return response
      }

      // 429 — will retry if we have attempts left
      lastResponse = response

      if (attempt < opts.maxRetries) {
        const delay = computeRetryDelay(attempt, opts, response.headers.get('Retry-After'))
        console.warn(
          `fetchWithRetry: 429 on attempt ${attempt + 1}/${opts.maxRetries + 1}, ` +
            `retrying in ${Math.round(delay)}ms`
        )
        await sleep(delay)
      }
    } catch (error) {
      // Network error — retry if we have attempts left
      lastError = error

      if (attempt < opts.maxRetries) {
        const delay = computeRetryDelay(attempt, opts, null)
        console.warn(
          `fetchWithRetry: network error on attempt ${attempt + 1}/${opts.maxRetries + 1}, ` +
            `retrying in ${Math.round(delay)}ms: ${error instanceof Error ? error.message : error}`
        )
        await sleep(delay)
      }
    }
  }

  // Exhausted all retries
  if (lastResponse) {
    return lastResponse
  }

  // All attempts failed with network errors
  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

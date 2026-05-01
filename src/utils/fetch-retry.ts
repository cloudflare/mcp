export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  backoffFactor?: number
  maxDelayMs?: number
  jitter?: boolean
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  backoffFactor: 2,
  maxDelayMs: 30_000,
  jitter: true
}
export function computeRetryDelay(
  attempt: number,
  opts: Required<RetryOptions>,
  retryAfterHeader?: string | null
): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader)
    if (!Number.isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, opts.maxDelayMs)
    }
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

  let lastResponse: Response | undefined
  let lastError: unknown

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const response = await fetch(input, init)

      if (response.status !== 429) {
        return response
      }

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

  if (lastResponse) {
    return lastResponse
  }

  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

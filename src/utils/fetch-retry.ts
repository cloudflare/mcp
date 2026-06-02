import { createLogger } from '../observability/logger'

const log = createLogger('fetch-retry')

export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  backoffFactor?: number
  maxDelayMs?: number
  jitter?: boolean
  caller?: string
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'caller'>> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  backoffFactor: 2,
  maxDelayMs: 30_000,
  jitter: true
}
export function computeRetryDelay(
  attempt: number,
  opts: Required<Omit<RetryOptions, 'caller'>>,
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
  const url = typeof input === 'string' ? input : input.url
  const caller = options?.caller

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
        log.warn('Received 429, retrying', {
          caller,
          url,
          attempt: attempt + 1,
          maxAttempts: opts.maxRetries + 1,
          delayMs: Math.round(delay)
        })
        await sleep(delay)
      }
    } catch (error) {
      lastError = error

      if (attempt < opts.maxRetries) {
        const delay = computeRetryDelay(attempt, opts, null)
        log.warn('Network error, retrying', {
          caller,
          url,
          attempt: attempt + 1,
          maxAttempts: opts.maxRetries + 1,
          delayMs: Math.round(delay),
          error
        })
        await sleep(delay)
      }
    }
  }

  if (lastResponse) {
    log.error('Request failed after all attempts', {
      caller,
      url,
      attempts: opts.maxRetries + 1,
      status: lastResponse.status
    })
    return lastResponse
  }

  log.error('Request failed after all attempts', {
    caller,
    url,
    attempts: opts.maxRetries + 1,
    error: lastError
  })
  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

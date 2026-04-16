import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchWithRetry, computeRetryDelay, type RetryOptions } from '../utils/fetch-retry'

describe('computeRetryDelay', () => {
  const defaults: Required<RetryOptions> = {
    maxRetries: 3,
    baseDelayMs: 1000,
    backoffFactor: 2,
    maxDelayMs: 30_000,
    jitter: false
  }

  it('computes exponential delays without jitter', () => {
    expect(computeRetryDelay(0, defaults)).toBe(1000) // 1000 * 2^0
    expect(computeRetryDelay(1, defaults)).toBe(2000) // 1000 * 2^1
    expect(computeRetryDelay(2, defaults)).toBe(4000) // 1000 * 2^2
    expect(computeRetryDelay(3, defaults)).toBe(8000) // 1000 * 2^3
  })

  it('caps delay at maxDelayMs', () => {
    expect(computeRetryDelay(5, defaults)).toBe(30_000) // 1000 * 2^5 = 32000, capped at 30000
  })

  it('respects Retry-After header (seconds)', () => {
    expect(computeRetryDelay(0, defaults, '5')).toBe(5000)
    expect(computeRetryDelay(0, defaults, '2')).toBe(2000)
  })

  it('caps Retry-After at maxDelayMs', () => {
    expect(computeRetryDelay(0, defaults, '60')).toBe(30_000) // 60s capped at 30s
  })

  it('ignores invalid Retry-After values', () => {
    expect(computeRetryDelay(0, defaults, 'invalid')).toBe(1000)
    expect(computeRetryDelay(0, defaults, '0')).toBe(1000)
    expect(computeRetryDelay(0, defaults, '-1')).toBe(1000)
  })

  it('applies jitter between 50% and 100%', () => {
    const opts = { ...defaults, jitter: true }
    const results = new Set<number>()
    for (let i = 0; i < 50; i++) {
      const delay = computeRetryDelay(0, opts)
      expect(delay).toBeGreaterThanOrEqual(500)
      expect(delay).toBeLessThanOrEqual(1000)
      results.add(Math.round(delay))
    }
    // With 50 samples, we should get some variation
    expect(results.size).toBeGreaterThan(1)
  })
})

describe('fetchWithRetry', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('returns immediately on 200', async () => {
    const mockResponse = new Response('ok', { status: 200 })
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse)

    const result = await fetchWithRetry('https://api.example.com/test')

    expect(result.status).toBe(200)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('returns immediately on non-429 errors (e.g. 401)', async () => {
    const mockResponse = new Response('unauthorized', { status: 401 })
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse)

    const result = await fetchWithRetry('https://api.example.com/test')

    expect(result.status).toBe(401)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('retries on 429 and succeeds', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    globalThis.fetch = mock

    const result = await fetchWithRetry('https://api.example.com/test', undefined, {
      maxRetries: 3,
      baseDelayMs: 10, // fast for tests
      jitter: false
    })

    expect(result.status).toBe(200)
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('returns last 429 response after exhausting retries', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }))
    globalThis.fetch = mock

    const result = await fetchWithRetry('https://api.example.com/test', undefined, {
      maxRetries: 2,
      baseDelayMs: 10,
      jitter: false
    })

    expect(result.status).toBe(429)
    // 1 initial + 2 retries = 3 total
    expect(mock).toHaveBeenCalledTimes(3)
  })

  it('retries on network errors and succeeds', async () => {
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network failure'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    globalThis.fetch = mock

    const result = await fetchWithRetry('https://api.example.com/test', undefined, {
      maxRetries: 3,
      baseDelayMs: 10,
      jitter: false
    })

    expect(result.status).toBe(200)
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('throws after exhausting retries on network errors', async () => {
    const mock = vi.fn().mockRejectedValue(new Error('network failure'))
    globalThis.fetch = mock

    await expect(
      fetchWithRetry('https://api.example.com/test', undefined, {
        maxRetries: 1,
        baseDelayMs: 10,
        jitter: false
      })
    ).rejects.toThrow('network failure')

    // 1 initial + 1 retry = 2 total
    expect(mock).toHaveBeenCalledTimes(2)
  })

  it('passes through request init options', async () => {
    const mockResponse = new Response('ok', { status: 200 })
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse)

    await fetchWithRetry('https://api.example.com/test', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
      body: '{"key":"value"}'
    })

    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.example.com/test', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
      body: '{"key":"value"}'
    })
  })

  it('respects Retry-After header from 429 response', async () => {
    const headers429 = new Headers({ 'Retry-After': '1' })
    const mock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: headers429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    globalThis.fetch = mock

    const start = Date.now()
    const result = await fetchWithRetry('https://api.example.com/test', undefined, {
      maxRetries: 3,
      baseDelayMs: 10, // would be 10ms without Retry-After
      jitter: false
    })

    const elapsed = Date.now() - start
    expect(result.status).toBe(200)
    // Retry-After: 1 means 1000ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(900) // allow small timing variance
  })

  it('handles mixed network errors and 429s', async () => {
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network failure'))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    globalThis.fetch = mock

    const result = await fetchWithRetry('https://api.example.com/test', undefined, {
      maxRetries: 3,
      baseDelayMs: 10,
      jitter: false
    })

    expect(result.status).toBe(200)
    expect(mock).toHaveBeenCalledTimes(3)
  })

  it('returns 429 if last response was 429 even after network errors', async () => {
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network failure'))
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
    globalThis.fetch = mock

    const result = await fetchWithRetry('https://api.example.com/test', undefined, {
      maxRetries: 1,
      baseDelayMs: 10,
      jitter: false
    })

    expect(result.status).toBe(429)
    expect(mock).toHaveBeenCalledTimes(2)
  })
})

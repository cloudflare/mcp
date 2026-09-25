import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchWithRetry,
  computeRetryDelay,
  serverRetryDelayMs,
  type RetryOptions
} from '../src/utils/fetch-retry'

describe('computeRetryDelay', () => {
  // computeRetryDelay takes the resolved options without `caller`.
  const defaults: Required<Omit<RetryOptions, 'caller'>> = {
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

  it('honours a server-given wait exactly, with no jitter', () => {
    expect(computeRetryDelay(0, { ...defaults, jitter: true }, 5000)).toBe(5000)
    expect(computeRetryDelay(2, defaults, 0)).toBe(0)
  })

  it('does not retry when the server asks for longer than maxDelayMs', () => {
    // Retrying at 30s against a 60s wait only spends the same quota on another 429.
    expect(computeRetryDelay(0, defaults, 60_000)).toBeUndefined()
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

describe('serverRetryDelayMs', () => {
  const headers = (init: Record<string, string>) => new Headers(init)

  it('reads Retry-After as seconds or as an HTTP date', () => {
    expect(serverRetryDelayMs(headers({ 'Retry-After': '5' }))).toBe(5000)
    expect(serverRetryDelayMs(headers({ 'Retry-After': '0' }))).toBe(0)
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')
    expect(serverRetryDelayMs(headers({ 'Retry-After': 'Wed, 21 Oct 2026 07:28:12 GMT' }), now)).toBe(12_000)
    expect(serverRetryDelayMs(headers({ 'Retry-After': 'Wed, 21 Oct 2026 07:27:00 GMT' }), now)).toBe(0)
  })

  it("falls back to the Cloudflare API's Ratelimit reset for an exhausted limit", () => {
    expect(serverRetryDelayMs(headers({ Ratelimit: '"default";r=0;t=30' }))).toBe(30_000)
    // Quota left: no reason to wait for the reset.
    expect(serverRetryDelayMs(headers({ Ratelimit: '"default";r=50;t=30' }))).toBeUndefined()
    // Several limits: wait for every exhausted one.
    expect(serverRetryDelayMs(headers({ Ratelimit: '"burst";r=0;t=4, "default";r=0;t=120' }))).toBe(120_000)
    // Retry-After wins when both are present.
    expect(serverRetryDelayMs(headers({ 'Retry-After': '2', Ratelimit: '"default";r=0;t=30' }))).toBe(2000)
  })

  it('ignores values it cannot read', () => {
    expect(serverRetryDelayMs(headers({ 'Retry-After': 'soon' }))).toBeUndefined()
    expect(serverRetryDelayMs(headers({ 'Retry-After': '-1' }))).toBeUndefined()
    expect(serverRetryDelayMs(headers({ 'Retry-After': '1.5' }))).toBeUndefined()
    expect(serverRetryDelayMs(headers({}))).toBeUndefined()
  })
})

describe('fetchWithRetry', () => {
  let originalFetch: typeof globalThis.fetch
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
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

  it('logs caller and url when retrying 429s', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    globalThis.fetch = mock

    const result = await fetchWithRetry('https://api.example.com/accounts', undefined, {
      maxRetries: 1,
      baseDelayMs: 1,
      jitter: false,
      caller: 'oauth_callback_identity_probe'
    })

    expect(result.status).toBe(200)
    expect(warnSpy).toHaveBeenCalledWith(
      'fetchWithRetry: 429 caller=oauth_callback_identity_probe url=https://api.example.com/accounts on attempt 1/2, retrying in 1ms'
    )
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

  it('logs an error after exhausting 429 retries', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }))
    globalThis.fetch = mock

    const result = await fetchWithRetry('https://api.example.com/accounts', undefined, {
      maxRetries: 0
    })

    expect(result.status).toBe(429)
    expect(errorSpy).toHaveBeenCalledWith(
      'fetchWithRetry: failed url=https://api.example.com/accounts after 1 attempts with status 429'
    )
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

  it('logs an error after exhausting network retries', async () => {
    const error = new Error('network failure')
    const mock = vi.fn().mockRejectedValue(error)
    globalThis.fetch = mock

    await expect(
      fetchWithRetry('https://api.example.com/accounts', undefined, {
        maxRetries: 0
      })
    ).rejects.toThrow('network failure')

    expect(errorSpy).toHaveBeenCalledWith(
      'fetchWithRetry: failed url=https://api.example.com/accounts after 1 attempts',
      error
    )
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

  it('passes through request init options and injects User-Agent', async () => {
    const mockResponse = new Response('ok', { status: 200 })
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse)

    await fetchWithRetry('https://api.example.com/test', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
      body: '{"key":"value"}'
    })

    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.example.com/test', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'User-Agent': 'cloudflare-mcp' },
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

  it('returns the 429 at once when the server asks to wait beyond maxDelayMs', async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(new Response('rate limited', { status: 429, headers: { 'Retry-After': '300' } }))
    globalThis.fetch = mock

    const result = await fetchWithRetry('https://api.example.com/user', undefined, { caller: 'probe' })

    expect(result.status).toBe(429)
    expect(result.headers.get('Retry-After')).toBe('300')
    expect(mock).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      'fetchWithRetry: 429 caller=probe url=https://api.example.com/user on attempt 1/4, not retrying: the server asks for 300s retry-after=300'
    )
  })

  it('waits for the Ratelimit reset when there is no Retry-After', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('rate limited', { status: 429, headers: { Ratelimit: '"default";r=0;t=1' } })
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    globalThis.fetch = mock

    const start = Date.now()
    const result = await fetchWithRetry('https://api.example.com/test', undefined, { baseDelayMs: 10 })

    expect(result.status).toBe(200)
    expect(Date.now() - start).toBeGreaterThanOrEqual(900)
    expect(warnSpy).toHaveBeenCalledWith(
      'fetchWithRetry: 429 url=https://api.example.com/test on attempt 1/4, retrying in 1000ms ratelimit="default";r=0;t=1'
    )
  })

  it('by default honours a server-given wait of up to 5 seconds', async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(new Response('rate limited', { status: 429, headers: { 'Retry-After': '6' } }))
    globalThis.fetch = mock

    // 6s is over the 5s default: no wait, the 429 goes straight back with its Retry-After.
    const result = await fetchWithRetry('https://api.example.com/test')

    expect(result.status).toBe(429)
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('keeps all three backoff retries when the server gives no wait', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }))
    globalThis.fetch = mock

    const result = await fetchWithRetry('https://api.example.com/test', undefined, {
      baseDelayMs: 1,
      jitter: false
    })

    expect(result.status).toBe(429)
    expect(mock).toHaveBeenCalledTimes(4)
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

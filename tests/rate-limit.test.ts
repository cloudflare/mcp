import { describe, expect, it } from 'vitest'
import { RATE_LIMIT_HEADER, rateLimited, withRateLimitHeader } from '../src/rate-limit'

const limited = (headers: Record<string, string>) => new Response(null, { status: 429, headers })

describe('rateLimited', () => {
  it('says nothing about a response that is not a 429', () => {
    const ok = new Response(null, { status: 200, headers: { Ratelimit: '"default";r=0;t=30' } })
    expect(rateLimited(ok)).toBeUndefined()
  })

  it("names a product's exhausted limit and the wait", () => {
    const result = rateLimited(
      limited({ 'Retry-After': '300', Ratelimit: '"rtwo_gw_apigw";r=0;t=300' })
    )
    expect(result).toMatchObject({ limit: 'rtwo_gw_apigw', waitMs: 300_000, everyEndpoint: false })
    expect(result?.hint).toBe(
      'Cloudflare rate limited this request (limit "rtwo_gw_apigw") and asks to wait 300 seconds. Do not send it again sooner: it will be refused again and count against the limit.'
    )
  })

  it('takes the exhausted default limit to cover every endpoint', () => {
    expect(rateLimited(limited({ Ratelimit: '"default";r=0;t=120' }))).toMatchObject({
      limit: 'default',
      waitMs: 120_000,
      everyEndpoint: true
    })
  })

  it('ignores a limit with quota left, as products send on their own 429s', () => {
    // URL Scanner and Email Routing send this with no Retry-After.
    const result = rateLimited(limited({ Ratelimit: '"default";r=1199;t=1' }))
    expect(result).toMatchObject({ limit: undefined, waitMs: undefined, everyEndpoint: false })
    expect(result?.hint).toContain('did not say for how long')
  })

  it('reads a Retry-After that names no limit', () => {
    expect(rateLimited(limited({ 'Retry-After': '10' }))).toMatchObject({
      limit: undefined,
      waitMs: 10_000,
      everyEndpoint: false
    })
  })
})

describe('withRateLimitHeader', () => {
  it('leaves other responses alone', () => {
    const ok = new Response('{}', { status: 200 })
    expect(withRateLimitHeader(ok)).toBe(ok)
  })

  it('adds what the 429 says and keeps its body', async () => {
    const response = withRateLimitHeader(
      new Response('limited', { status: 429, headers: { 'Retry-After': '60' } })
    )
    expect(JSON.parse(decodeURIComponent(response.headers.get(RATE_LIMIT_HEADER)!))).toMatchObject({
      waitMs: 60_000
    })
    expect(await response.text()).toBe('limited')
  })
})

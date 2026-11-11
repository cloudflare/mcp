import { describe, expect, it } from 'vitest'
import {
  holdOf,
  holdScope,
  limitsOf,
  LONGEST_WAIT_MS,
  RATE_LIMIT_HEADER,
  rateLimitHint,
  withRateLimitNotice,
  type RateLimitNotice
} from '../src/rate-limit'

const headers = (init: Record<string, string>) => new Headers(init)

/** The shared limit as the API sends it, with `remaining` requests left. */
const shared = (remaining: number) =>
  headers({
    Ratelimit: `"default";r=${remaining};t=${Math.ceil((1200 - remaining) / 4)}`,
    'Ratelimit-Policy': '"default";q=1200;w=300'
  })

describe('limitsOf', () => {
  it('reads each limit with its policy', () => {
    expect(limitsOf(shared(1147))).toEqual([
      {
        name: 'default',
        remaining: 1147,
        refillSeconds: 14,
        policy: { quota: 1200, windowSeconds: 300 }
      }
    ])
  })

  it('reads several limits, and one without a policy', () => {
    const limits = limitsOf(
      headers({
        Ratelimit: '"default";r=50;t=30, "burst";r=3;t=2',
        'Ratelimit-Policy': '"burst";q=100;w=60'
      })
    )
    expect(limits.map(({ name, policy }) => [name, policy?.quota])).toEqual([
      ['default', undefined],
      ['burst', 100]
    ])
  })

  it('finds none on a response without the headers, as D1 and KV send', () => {
    expect(limitsOf(headers({}))).toEqual([])
  })
})

describe('holdOf', () => {
  it('asks for nothing while the bucket is above its reserve', () => {
    expect(holdOf(200, shared(1147))).toBeUndefined()
    // The reserve is 5% of 1,200.
    expect(holdOf(200, shared(60))).toBeUndefined()
  })

  it('paces below the reserve: long enough for the bucket to refill to it', () => {
    // One request short, at 4 requests a second.
    expect(holdOf(200, shared(59))).toEqual({ limit: 'default', waitMs: 250 })
    expect(holdOf(403, shared(50))).toEqual({ limit: 'default', waitMs: 2500 })
  })

  it('never paces for longer than a run waits', () => {
    expect(holdOf(200, shared(0))).toEqual({ limit: 'default', waitMs: LONGEST_WAIT_MS })
  })

  it('does not pace a limit that sends no policy', () => {
    expect(holdOf(200, headers({ Ratelimit: '"default";r=0;t=300' }))).toBeUndefined()
  })

  it('holds for as long as a 429 asks, under the limit it exhausted', () => {
    const limited = headers({ 'Retry-After': '300', Ratelimit: '"rtwo_gw_apigw";r=0;t=300' })
    expect(holdOf(429, limited)).toEqual({ limit: 'rtwo_gw_apigw', waitMs: 300_000 })
    expect(holdOf(429, headers({ 'Retry-After': '10' }))).toEqual({
      limit: undefined,
      waitMs: 10_000
    })
  })

  it("asks for nothing on a product's own 429 that gives no wait", () => {
    // URL Scanner and Email Routing send the untouched shared limit and no Retry-After.
    expect(holdOf(429, shared(1199))).toBeUndefined()
    expect(holdOf(429, headers({}))).toBeUndefined()
  })
})

describe('rateLimitHint', () => {
  it('is only for a 429', () => {
    expect(rateLimitHint(200, shared(0))).toBeUndefined()
  })

  it('names the limit and the wait', () => {
    expect(
      rateLimitHint(429, headers({ 'Retry-After': '300', Ratelimit: '"rtwo_gw_apigw";r=0;t=300' }))
    ).toBe(
      'Cloudflare rate limited this request (limit "rtwo_gw_apigw") and asks to wait 300 seconds. Do not send it again sooner: it will be refused again and count against the limit.'
    )
  })

  it('says so when Cloudflare gives no wait', () => {
    expect(rateLimitHint(429, shared(1199))).toContain('did not say for how long')
  })
})

describe('holdScope', () => {
  const ACCOUNT = '00000000000000000000000000000001'
  const paths = {
    '/accounts/{account_id}/r2/buckets': { get: {} },
    '/accounts/{account_id}/r2/buckets/{bucket_name}/objects/{object_name}': { get: {}, put: {} },
    '/accounts/{account_id}/registrar/domain-check': { post: {} },
    '/zones': { get: {} }
  }
  const covers = (scope: { method?: string; pattern?: string }, method: string, path: string) =>
    (!scope.method || scope.method === method) &&
    (!scope.pattern || new RegExp(scope.pattern).test(path))

  it('covers every request for the shared limit', () => {
    expect(holdScope('default', paths, 'GET', `/accounts/${ACCOUNT}/r2/buckets`)).toEqual({})
  })

  it("covers the operation that reported another limit, on the request's account", () => {
    const scope = holdScope(
      'rtwo_gw_apigw',
      paths,
      'get',
      `/accounts/${ACCOUNT}/r2/buckets/b/objects/a.json`
    )
    expect(covers(scope, 'GET', `/accounts/${ACCOUNT}/r2/buckets/other/objects/z`)).toBe(true)
    expect(covers(scope, 'GET', `/accounts/${ACCOUNT}/r2/buckets/b/objects/dir/z.json`)).toBe(true)
    expect(covers(scope, 'PUT', `/accounts/${ACCOUNT}/r2/buckets/b/objects/a.json`)).toBe(false)
    expect(covers(scope, 'GET', `/accounts/${ACCOUNT}/r2/buckets`)).toBe(false)
    expect(covers(scope, 'GET', '/accounts/another/r2/buckets/b/objects/a.json')).toBe(false)
  })

  it('finds the operation of an object key with slashes in it', () => {
    const scope = holdScope(
      'rtwo_gw_apigw',
      paths,
      'GET',
      `/accounts/${ACCOUNT}/r2/buckets/b/objects/content/v4.1/c3876.json`
    )
    expect(
      covers(scope, 'GET', `/accounts/${ACCOUNT}/r2/buckets/b/objects/content/v4.1/c1.json`)
    ).toBe(true)
    expect(covers(scope, 'GET', `/accounts/${ACCOUNT}/r2/buckets/b/objects/top.json`)).toBe(true)
    expect(covers(scope, 'GET', `/accounts/${ACCOUNT}/r2/buckets`)).toBe(false)
  })

  it('does not take a longer path for an operation that ends in a literal', () => {
    const path = `/accounts/${ACCOUNT}/registrar/domain-check/extra`
    const scope = holdScope('registrar_domain_check', paths, 'POST', path)
    expect(covers(scope, 'POST', path)).toBe(true)
    expect(covers(scope, 'POST', `/accounts/${ACCOUNT}/registrar/domain-check`)).toBe(false)
  })

  it('covers only its own path for a request the spec does not list, or without the spec', () => {
    const scope = holdScope(undefined, paths, 'GET', '/unlisted/thing.json')
    expect(covers(scope, 'GET', '/unlisted/thing.json')).toBe(true)
    expect(covers(scope, 'GET', '/unlisted/thingXjson')).toBe(false)
    expect(holdScope('list_zones', undefined, 'GET', '/zones')).toEqual({
      method: 'GET',
      pattern: '^\\/zones\\/?$'
    })
  })
})

describe('withRateLimitNotice', () => {
  const notice = (response: Response) =>
    JSON.parse(decodeURIComponent(response.headers.get(RATE_LIMIT_HEADER)!)) as RateLimitNotice

  it('leaves a response that asks for nothing alone', async () => {
    const ok = new Response('{}', { status: 200, headers: shared(1147) })
    expect(await withRateLimitNotice(ok, 'GET', '/user')).toBe(ok)
  })

  it('adds the hold and the hint of a 429, and keeps its body', async () => {
    const response = await withRateLimitNotice(
      new Response('limited', { status: 429, headers: shared(0) }),
      'GET',
      '/user'
    )
    expect(notice(response)).toMatchObject({ hold: { limit: 'default', waitMs: 300_000 } })
    expect(notice(response).hint).toContain('asks to wait 300 seconds')
    expect(notice(response).pattern).toBeUndefined()
    expect(await response.text()).toBe('limited')
  })

  it('adds the pacing hold of a response close to its limit, with no hint', async () => {
    const response = await withRateLimitNotice(
      new Response('{}', { status: 200, headers: shared(40) }),
      'GET',
      '/user'
    )
    expect(notice(response)).toEqual({ hold: { limit: 'default', waitMs: 5000 } })
  })

  it('tells the agent about a 429 that asks for no hold', async () => {
    const response = await withRateLimitNotice(new Response(null, { status: 429 }), 'GET', '/user')
    expect(notice(response).hold).toBeUndefined()
    expect(notice(response).hint).toContain('did not say for how long')
  })
})

import { env } from 'cloudflare:workers'
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { clearR2 } from './helpers/r2'
import { server } from './setup/msw'
import worker from '../src/index'

/**
 * Integration tests for the scheduled() handler. The GitHub spec fetch is the
 * only mocked boundary (MSW); the R2 bucket is the REAL `env.SPEC_BUCKET`
 * binding, asserted by reading objects back out. Drives the handler with real
 * ScheduledController / ExecutionContext instances.
 */

const SPEC_URL = env.OPENAPI_SPEC_URL

const RAW_SPEC = {
  openapi: '3.0.0',
  info: { title: 'Test', version: '1.0' },
  paths: {
    '/accounts/{account_id}/workers/scripts': {
      get: {
        summary: 'List Workers',
        tags: ['Workers Scripts'],
        parameters: [],
        responses: { '200': { description: 'OK' } }
      }
    }
  }
}

async function runScheduled() {
  const controller = createScheduledController({ scheduledTime: Date.now(), cron: '0 0 * * *' })
  const ctx = createExecutionContext()
  await worker.scheduled!(controller, env, ctx)
  await waitOnExecutionContext(ctx)
}

afterEach(() => clearR2(env.SPEC_BUCKET))

describe('scheduled handler', () => {
  it('fetches the spec from GitHub, processes it, and writes spec + products to real R2', async () => {
    server.use(http.get(SPEC_URL, () => HttpResponse.json(RAW_SPEC)))

    await runScheduled()

    // Read the real bucket back out.
    const specObj = await env.SPEC_BUCKET.get('spec.json')
    const productsObj = await env.SPEC_BUCKET.get('products.json')
    expect(specObj).not.toBeNull()
    expect(productsObj).not.toBeNull()

    const spec = (await specObj!.json()) as { paths: Record<string, unknown> }
    expect(spec.paths['/accounts/{account_id}/workers/scripts']).toBeDefined()

    const products = (await productsObj!.json()) as string[]
    expect(products).toContain('workers')
  })

  it('throws and writes nothing when GitHub returns a non-2xx', async () => {
    server.use(http.get(SPEC_URL, () => new HttpResponse('Not Found', { status: 404 })))

    await expect(runScheduled()).rejects.toThrow('Failed to fetch OpenAPI spec: 404')

    // Nothing should have been written to R2.
    const { objects } = await env.SPEC_BUCKET.list()
    expect(objects).toHaveLength(0)
  })

  // Bug-exposing: the daily cron uses a bare fetch() with no retry, unlike the
  // rest of the codebase (fetchWithRetry). A single transient 5xx skips the
  // spec update for the day. This test asserts the CURRENT (no-retry) behaviour;
  // flip the expectation if/when scheduled() gains retry.
  it('does NOT retry a transient GitHub 5xx (documents missing retry)', async () => {
    let calls = 0
    server.use(
      http.get(SPEC_URL, () => {
        calls++
        return calls === 1
          ? new HttpResponse('boom', { status: 503 })
          : HttpResponse.json(RAW_SPEC)
      })
    )

    await expect(runScheduled()).rejects.toThrow('Failed to fetch OpenAPI spec: 503')
    expect(calls).toBe(1) // gave up after the first failure
    expect((await env.SPEC_BUCKET.list()).objects).toHaveLength(0)
  })

  // Bug-exposing: a 200 response with a non-JSON body (e.g. a GitHub rate-limit
  // HTML page) makes response.json() throw a raw SyntaxError rather than a clean
  // "Failed to fetch OpenAPI spec" message. Documents current behaviour.
  it('throws a raw parse error on a 200 non-JSON body (no graceful message)', async () => {
    server.use(http.get(SPEC_URL, () => new HttpResponse('<html>rate limited</html>', { status: 200 })))

    // Not the friendly "Failed to fetch OpenAPI spec" error.
    await expect(runScheduled()).rejects.toThrow()
    await expect(runScheduled()).rejects.not.toThrow('Failed to fetch OpenAPI spec')
    expect((await env.SPEC_BUCKET.list()).objects).toHaveLength(0)
  })
})

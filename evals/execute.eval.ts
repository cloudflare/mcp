import { env } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { API_BASE, cfSuccess, mockIdentityProbe } from '../tests/helpers/cloudflare-api'
import { clearKv } from '../tests/helpers/kv'
import { clearSpec, seedSpec } from '../tests/helpers/spec'
import { server } from '../tests/setup/msw'
import { EVAL_PRODUCTS, EVAL_SPEC_PATHS } from './fixtures'
import { runAgentTask } from './harness'
import { eachEvalModel } from './models'

/**
 * Given a natural-language task, does the model call the *right* Cloudflare
 * API endpoint through `execute`? Both `search` and `execute` are available
 * (matching real usage — the `execute` tool description tells the model to
 * search first), but the assertion is on the real outbound HTTP request MSW
 * observed, not on which tools were called — that's the only way to know the
 * generated `cloudflare.request()` call was actually correct.
 */

const API_TOKEN = 'cfat_eval-execute-token'
const ACCOUNT_ID = '00000000000000000000000000000001'

beforeEach(async () => {
  await seedSpec(EVAL_SPEC_PATHS, EVAL_PRODUCTS)
  mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Eval Account' }] })
})

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

eachEvalModel('$modelName', ({ model }) => {
  describe('execute tool', () => {
    it('lists Workers scripts', async () => {
      const requests: Array<{ method: string; path: string }> = []
      server.use(
        http.get(`${API_BASE}/accounts/:accountId/workers/scripts`, ({ params }) => {
          requests.push({ method: 'GET', path: `/accounts/${params.accountId}/workers/scripts` })
          return HttpResponse.json(
            cfSuccess([{ id: 'my-worker', etag: 'abc123', modified_on: '2025-01-01' }])
          )
        })
      )

      await runAgentTask({
        model,
        token: API_TOKEN,
        prompt: 'List all my Cloudflare Workers scripts.'
      })

      expect(requests, 'no request hit the Workers scripts endpoint').toContainEqual({
        method: 'GET',
        path: `/accounts/${ACCOUNT_ID}/workers/scripts`
      })
    })

    it('lists KV namespaces', async () => {
      const requests: Array<{ method: string; path: string }> = []
      server.use(
        http.get(`${API_BASE}/accounts/:accountId/storage/kv/namespaces`, ({ params }) => {
          requests.push({
            method: 'GET',
            path: `/accounts/${params.accountId}/storage/kv/namespaces`
          })
          return HttpResponse.json(
            cfSuccess([{ id: 'ns-1', title: 'MY_KV', supports_url_encoding: true }])
          )
        })
      )

      await runAgentTask({
        model,
        token: API_TOKEN,
        prompt: 'List all my Workers KV namespaces.'
      })

      expect(requests, 'no request hit the KV namespaces endpoint').toContainEqual({
        method: 'GET',
        path: `/accounts/${ACCOUNT_ID}/storage/kv/namespaces`
      })
    })

    it('creates a D1 database with the requested name', async () => {
      const requests: Array<{ method: string; path: string; body: unknown }> = []
      server.use(
        http.post(`${API_BASE}/accounts/:accountId/d1/database`, async ({ params, request }) => {
          requests.push({
            method: 'POST',
            path: `/accounts/${params.accountId}/d1/database`,
            body: await request.json()
          })
          return HttpResponse.json(
            cfSuccess({ uuid: 'db-123', name: 'orders-db', created_at: '2025-01-01' })
          )
        })
      )

      await runAgentTask({
        model,
        token: API_TOKEN,
        prompt: 'Create a new D1 database called "orders-db".'
      })

      expect(requests, 'no request hit the D1 database creation endpoint').toContainEqual(
        expect.objectContaining({
          method: 'POST',
          path: `/accounts/${ACCOUNT_ID}/d1/database`,
          body: expect.objectContaining({ name: 'orders-db' })
        })
      )
    })
  })
})

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
 * The full loop the tool descriptions actually prescribe: `search` to find an
 * endpoint neither tool description names outright, then `execute` to call
 * it. Asserts both halves — that `search` ran, and that the request MSW
 * observed hit the endpoint `search` was supposed to have found.
 */

const API_TOKEN = 'cfat_eval-e2e-token'
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
  describe('search then execute', () => {
    it('finds and calls the DNS zones endpoint', async () => {
      const requests: Array<{ method: string; path: string }> = []
      server.use(
        http.get(`${API_BASE}/zones`, () => {
          requests.push({ method: 'GET', path: '/zones' })
          return HttpResponse.json(
            cfSuccess([
              { id: 'zone-1', name: 'example.com', status: 'active' },
              { id: 'zone-2', name: 'test.dev', status: 'active' }
            ])
          )
        })
      )

      const { toolCalls } = await runAgentTask({
        model,
        token: API_TOKEN,
        prompt: 'Find the API endpoint to list DNS zones, then call it and tell me the zone names.'
      })

      expect(
        toolCalls.some((call) => call.toolName === 'search'),
        'search was not called'
      ).toBe(true)
      expect(
        toolCalls.some((call) => call.toolName === 'execute'),
        'execute was not called'
      ).toBe(true)
      expect(requests, 'no request hit the zones endpoint').toContainEqual({
        method: 'GET',
        path: '/zones'
      })
    })
  })
})

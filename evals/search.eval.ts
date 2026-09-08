import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mockIdentityProbe } from '../tests/helpers/cloudflare-api'
import { clearKv } from '../tests/helpers/kv'
import { clearSpec, seedSpec } from '../tests/helpers/spec'
import { EVAL_PRODUCTS, EVAL_SPEC_PATHS } from './fixtures'
import { runAgentTask } from './harness'
import { eachEvalModel } from './models'

/**
 * Does the model reach for `search` and find the right endpoint, given only
 * its tool description and a natural-language task? Each case seeds a small
 * fixed spec (see fixtures.ts) and inspects the `search` tool's own result —
 * not the model's prose — so a case only passes when the returned code
 * actually located the right path.
 */

const API_TOKEN = 'cfat_eval-search-token'
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
  describe('search tool', () => {
    it('finds the Workers scripts list endpoint', async () => {
      const { toolCalls, toolResults } = await runAgentTask({
        model,
        token: API_TOKEN,
        prompt: 'Find the API endpoint used to list Workers scripts on an account. Do not call it.',
        toolNames: ['search']
      })

      expect(
        toolCalls.some((call) => call.toolName === 'search'),
        'search was not called'
      ).toBe(true)
      expect(
        toolResults.some(
          (result) =>
            result.toolName === 'search' &&
            String(result.output).includes('/accounts/{account_id}/workers/scripts')
        ),
        'search result did not surface the Workers scripts endpoint'
      ).toBe(true)
    })

    it('finds the endpoint to create a KV namespace', async () => {
      const { toolCalls, toolResults } = await runAgentTask({
        model,
        token: API_TOKEN,
        prompt: 'Find the API endpoint used to create a new Workers KV namespace. Do not call it.',
        toolNames: ['search']
      })

      expect(
        toolCalls.some((call) => call.toolName === 'search'),
        'search was not called'
      ).toBe(true)
      expect(
        toolResults.some(
          (result) =>
            result.toolName === 'search' &&
            String(result.output).includes('/accounts/{account_id}/storage/kv/namespaces')
        ),
        'search result did not surface the KV namespace creation endpoint'
      ).toBe(true)
    })

    it('finds the endpoint to list DNS zones', async () => {
      const { toolCalls, toolResults } = await runAgentTask({
        model,
        token: API_TOKEN,
        prompt: 'Find the API endpoint used to list DNS zones. Do not call it.',
        toolNames: ['search']
      })

      expect(
        toolCalls.some((call) => call.toolName === 'search'),
        'search was not called'
      ).toBe(true)
      expect(
        toolResults.some(
          (result) => result.toolName === 'search' && String(result.output).includes('/zones')
        ),
        'search result did not surface the zones endpoint'
      ).toBe(true)
    })
  })
})

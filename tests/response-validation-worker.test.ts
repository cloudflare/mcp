import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { API_BASE, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, mcpToolCallRequest, parseMcpResult, toolText } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'
import source from '../src/generated/forge-mcp/source.json'
import { stringifyResponse } from '../src/truncate'

/**
 * Response schema checks through the real worker, for both direct-tool
 * surfaces, against the response schemas forge generated: `d1_list` backs
 * both the endpoint tool `get_accounts_d1_database` and the forge tool. The
 * Cloudflare API is the only mocked boundary (MSW); the forge tools service
 * runs for real. Checks run in `waitUntil` after the result is built, so tests
 * wait for the datapoint.
 */

const ACCOUNT_ID = '00000000000000000000000000000001'
const TOKEN = 'acct-token-response-validation'
const D1_URL = `${API_BASE}/accounts/${ACCOUNT_ID}/d1/database`
const SECRET = 'customer-secret-value'

type DataPoint = { indexes?: string[]; blobs?: Array<string | null>; doubles?: number[] }

function mismatches(spy: { mock: { calls: unknown[][] } }): DataPoint[] {
  return spy.mock.calls
    .map((args) => args[0] as DataPoint)
    .filter((dp) => dp?.indexes?.[0] === 'response_schema_mismatch')
}

async function call(query: string, name: string, args: Record<string, unknown> = {}) {
  const request = new Request(`${MCP_URL}?${query}`, mcpToolCallRequest(TOKEN, name, args))
  return parseMcpResult(await exports.default.fetch(request))
}

const endpointTool = () => call('codemode=false', 'get_accounts_d1_database')
const forgeTool = (name = 'd1_list', args: Record<string, unknown> = {}) =>
  call('codemode=false&experimentalForge=true', name, args)

/** Background work has no handle; give it time to finish before asserting nothing happened. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200))

beforeEach(async () => {
  // Off for every other test file (vitest.config.ts).
  Object.assign(env, { RESPONSE_VALIDATION_SAMPLE_RATE: '1' })
  await seedSpec({
    '/accounts/{account_id}/d1/database': {
      get: { summary: 'List D1 Databases', parameters: [{ name: 'account_id', in: 'path' }] }
    },
    '/accounts/{account_id}/not-generated': {
      get: {
        summary: 'Not in the generated tools',
        parameters: [{ name: 'account_id', in: 'path' }]
      }
    }
  })
  mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
})

afterEach(async () => {
  Object.assign(env, { RESPONSE_VALIDATION_SAMPLE_RATE: '0' })
  vi.restoreAllMocks()
  await clearSpec()
  await clearKv(env.OAUTH_KV)
})

describe('direct-tool response schema checks', () => {
  it('records one mismatch for an endpoint tool and leaves its result unchanged', async () => {
    const body = cfSuccess([{ uuid: 42, name: SECRET }, { uuid: 7 }])
    server.use(http.get(D1_URL, () => HttpResponse.json(body)))
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await endpointTool()

    expect(result.result?.isError).toBeFalsy()
    expect(toolText(result)).toBe(stringifyResponse(body))
    await vi.waitFor(() => expect(mismatches(writeSpy)).toHaveLength(1))
    expect(mismatches(writeSpy)[0]).toEqual({
      indexes: ['response_schema_mismatch'],
      blobs: [
        'cloudflare-api',
        expect.any(String),
        null, // account token: no user
        'get_accounts_d1_database',
        'GET',
        '/accounts/{account_id}/d1/database',
        'd1',
        'd1_list', // the generated tool whose schema was used
        '200',
        'type',
        '#/components/schemas/d1_database-identifier/type',
        '/result/*/uuid',
        source.release
      ],
      doubles: [0, 200, 2, 1, 1]
    })

    const logged = warnSpy.mock.calls.map((args) => String(args[0]))
    const line = logged.find((text) => text.includes('response_schema_mismatch'))
    expect(JSON.parse(line!)).toMatchObject({
      message: 'response_schema_mismatch',
      forgeTool: 'd1_list',
      errorCount: 2,
      errors: [
        { keyword: 'type', instancePath: '/result/*/uuid' },
        { keyword: 'type', instancePath: '/result/*/uuid' }
      ]
    })
    // Neither the datapoint nor the log line carries response values.
    expect(JSON.stringify(writeSpy.mock.calls)).not.toContain(SECRET)
    expect(logged.join('\n')).not.toContain(SECRET)
  })

  it('checks forge tool responses against the same generated schema', async () => {
    const body = cfSuccess([{ uuid: 42 }])
    server.use(http.get(D1_URL, () => HttpResponse.json(body)))
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await forgeTool()

    expect(toolText(result)).toBe(stringifyResponse(body))
    await vi.waitFor(() => expect(mismatches(writeSpy)).toHaveLength(1))
    expect(mismatches(writeSpy)[0].blobs?.slice(3, 11)).toEqual([
      'd1_list',
      'GET',
      '/accounts/{account_id}/d1/database',
      'd1',
      'd1_list',
      '200',
      'type',
      '#/components/schemas/d1_database-identifier/type'
    ])
  })

  it('finds the schema of a forge tool on a merged account-or-zone path', async () => {
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/access/apps`, () =>
        HttpResponse.json(cfSuccess('not a list'))
      )
    )
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await forgeTool('zero_trust_access_applications_list', { account_or_zone: 'accounts' })

    await vi.waitFor(() => expect(mismatches(writeSpy)).toHaveLength(1))
    expect(mismatches(writeSpy)[0].blobs?.slice(5, 12)).toEqual([
      '/{account_or_zone}/{account_or_zone_id}/access/apps',
      'access',
      'zero_trust_access_applications_list',
      '200',
      'type',
      '#/responses/200/schema/properties/result/type',
      '/result'
    ])
  })

  it('checks error responses against their own schema', async () => {
    const body = {
      success: false,
      errors: [{ code: '10000', message: 'Authentication error' }],
      messages: [],
      result: null
    }
    server.use(http.get(D1_URL, () => HttpResponse.json(body, { status: 403 })))
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await endpointTool()

    expect(result.result?.isError).toBe(true)
    expect(toolText(result)).toContain('returned HTTP 403')
    await vi.waitFor(() => expect(mismatches(writeSpy)).toHaveLength(1))
    const [dp] = mismatches(writeSpy)
    expect(dp.blobs?.slice(8, 12)).toEqual([
      '4XX',
      'type',
      '#/components/schemas/d1_messages/items/properties/code/type',
      '/errors/*/code'
    ])
    expect(dp.doubles?.[1]).toBe(403)
  })

  it('records nothing for a response that matches, or an operation with no generated tool', async () => {
    server.use(
      http.get(D1_URL, () => HttpResponse.json(cfSuccess([{ uuid: 'db-1' }]))),
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/not-generated`, () =>
        HttpResponse.json(cfSuccess(42))
      )
    )
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')

    const matching = await endpointTool()
    await call('codemode=false', 'get_accounts_not_generated')
    await settle()

    expect(toolText(matching)).toContain('db-1')
    expect(mismatches(writeSpy)).toHaveLength(0)
  })

  it('serves the tool result when recording the mismatch fails', async () => {
    const body = cfSuccess([{ uuid: 7 }])
    server.use(http.get(D1_URL, () => HttpResponse.json(body)))
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint').mockImplementation(() => {
      throw new Error('Analytics Engine down')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await endpointTool()

    expect(toolText(result)).toBe(stringifyResponse(body))
    await vi.waitFor(() => expect(mismatches(writeSpy)).toHaveLength(1))
  })
})

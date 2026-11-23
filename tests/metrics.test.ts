import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTH_USER_LAYOUT,
  AuthUser,
  MetricsEventIndexId,
  MetricsError,
  MetricsTracker,
  RESPONSE_SCHEMA_MISMATCH_LAYOUT,
  ResponseSchemaMismatch,
  TOOL_CALL_LAYOUT,
  ToolCall
} from '../src/metrics'
import { API_BASE, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { clearSpec, seedSpec } from './helpers/spec'
import {
  MCP_URL,
  callTool,
  mcpToolCallRequest,
  modernMcpRequest,
  parseMcpResult
} from './helpers/mcp'
import { server } from './setup/msw'

const SERVER_INFO = { name: 'cloudflare-api', version: '0.1.0' }

describe('shared positional schema', () => {
  it('pins every blob position so renumbering fails the build', () => {
    expect(TOOL_CALL_LAYOUT).toEqual({
      userId: 3,
      toolName: 4,
      clientName: 5,
      clientVersion: 6,
      era: 7,
      clientId: 8
    })
    expect(AUTH_USER_LAYOUT).toEqual({ userId: 3, errorMessage: 4 })
    expect(RESPONSE_SCHEMA_MISMATCH_LAYOUT).toEqual({
      userId: 3,
      toolName: 4,
      method: 5,
      pathTemplate: 6,
      product: 7,
      forgeTool: 8,
      responseKey: 9,
      keyword: 10,
      schemaLocation: 11,
      instancePath: 12,
      specRelease: 13
    })
  })
})

describe('ToolCall', () => {
  it('maps a successful tool call to the correct datapoint', () => {
    const event = new ToolCall({ userId: 'user-1', toolName: 'execute' })
    event.serverInfo = SERVER_INFO
    const dp = event.toDataPoint()

    expect(dp.indexes).toEqual([MetricsEventIndexId.TOOL_CALL])
    // blob1/blob2 reserved for server name/version, blob3=userId, blob4=toolName,
    // blob5=client name, blob6=client version, blob7=era, blob8=OAuth client ID
    expect(dp.blobs).toEqual([
      'cloudflare-api',
      '0.1.0',
      'user-1',
      'execute',
      null,
      null,
      null,
      null
    ])
    // double1 = errorCode (undefined when success)
    expect(dp.doubles).toEqual([undefined])
  })

  it('maps client identity into blob5-8', () => {
    const event = new ToolCall({
      userId: 'user-1',
      toolName: 'execute',
      clientName: 'cursor',
      clientVersion: '2.1.0',
      era: 'modern',
      clientId: 'mcp-client'
    })
    event.serverInfo = SERVER_INFO
    const dp = event.toDataPoint()

    expect(dp.blobs?.[4]).toBe('cursor')
    expect(dp.blobs?.[5]).toBe('2.1.0')
    expect(dp.blobs?.[6]).toBe('modern')
    expect(dp.blobs?.[7]).toBe('mcp-client')
    expect(dp.blobs?.length).toBe(8)
  })

  it('includes the errorCode for failed tool calls', () => {
    const event = new ToolCall({ userId: 'user-1', toolName: 'search', errorCode: -32602 })
    event.serverInfo = SERVER_INFO
    const dp = event.toDataPoint()

    expect(dp.doubles).toEqual([-32602])
  })
})

describe('AuthUser', () => {
  it('maps userId and errorMessage', () => {
    const event = new AuthUser({ userId: 'user-1', errorMessage: 'denied' })
    event.serverInfo = SERVER_INFO
    const dp = event.toDataPoint()

    expect(dp.indexes).toEqual([MetricsEventIndexId.AUTH_USER])
    expect(dp.blobs).toEqual(['cloudflare-api', '0.1.0', 'user-1', 'denied'])
  })
})

describe('ResponseSchemaMismatch', () => {
  it('keeps the shared slots and puts mismatch fields in the later ones', () => {
    const event = new ResponseSchemaMismatch({
      userId: 'user-1',
      toolName: 'get_zones_dns_records',
      method: 'GET',
      pathTemplate: '/zones/{zone_id}/dns_records',
      product: 'dns_records',
      forgeTool: 'dns_records_list',
      responseKey: '200',
      specRelease: 'openapi@933e9f6',
      status: 200,
      errorCount: 3,
      counted: true,
      sampleInterval: 4,
      first: {
        keyword: 'required',
        schemaLocation: '#/components/schemas/dns-records_dns-record-response/required',
        instancePath: '/result/*'
      }
    })
    event.serverInfo = SERVER_INFO
    const dp = event.toDataPoint()

    expect(dp.indexes).toEqual([MetricsEventIndexId.RESPONSE_SCHEMA_MISMATCH])
    expect(dp.indexes).toEqual(['response_schema_mismatch'])
    expect(dp.blobs).toEqual([
      'cloudflare-api', // blob1 server name
      '0.1.0', // blob2 server version
      'user-1', // blob3 userId
      'get_zones_dns_records', // blob4 toolName
      'GET', // blob5 method
      '/zones/{zone_id}/dns_records', // blob6 path template
      'dns_records', // blob7 product
      'dns_records_list', // blob8 forge tool
      '200', // blob9 response key
      'required', // blob10 keyword
      '#/components/schemas/dns-records_dns-record-response/required', // blob11 schema location
      '/result/*', // blob12 instance path
      'openapi@933e9f6' // blob13 spec release
    ])
    // double1 errorCode 0, double2 status, double3 count, double4 sample interval, double5 counted
    expect(dp.doubles).toEqual([0, 200, 3, 4, 1])
  })

  it('writes null for an absent user or spec release, keeping later positions in place', () => {
    const event = new ResponseSchemaMismatch({
      toolName: 't',
      method: 'GET',
      pathTemplate: '/p',
      product: 'p',
      forgeTool: 't_list',
      responseKey: 'default',
      specRelease: null,
      status: 500,
      errorCount: 1,
      counted: false,
      sampleInterval: 1,
      first: {
        keyword: 'type',
        schemaLocation: '#/responses/default/schema/type',
        instancePath: '/'
      }
    })
    event.serverInfo = SERVER_INFO
    const dp = event.toDataPoint()

    expect(dp.blobs?.[2]).toBeNull()
    expect(dp.blobs?.[7]).toBe('t_list')
    expect(dp.blobs?.[8]).toBe('default')
    expect(dp.blobs?.[12]).toBeNull()
    expect(dp.doubles).toEqual([0, 500, 1, 1, 0])
  })
})

describe('MetricsEvent guards', () => {
  it('throws when server info is not set', () => {
    const event = new ToolCall({ toolName: 'execute' })
    expect(() => event.toDataPoint()).toThrow(MetricsError)
  })

  it('rejects attempts to set reserved blobs', () => {
    const event = new ToolCall({ toolName: 'execute' })
    event.serverInfo = SERVER_INFO
    expect(() => event.mapBlobs({ blob1: 'nope' })).toThrow(MetricsError)
  })
})

describe('MetricsTracker', () => {
  afterEach(() => vi.restoreAllMocks())

  it('writes a datapoint to the real binding with server info injected', () => {
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')
    const tracker = new MetricsTracker(env.MCP_METRICS, SERVER_INFO)

    tracker.logEvent(new ToolCall({ userId: 'user-1', toolName: 'execute' }))

    expect(writeSpy).toHaveBeenCalledTimes(1)
    expect(writeSpy).toHaveBeenCalledWith({
      indexes: [MetricsEventIndexId.TOOL_CALL],
      blobs: ['cloudflare-api', '0.1.0', 'user-1', 'execute', null, null, null, null],
      doubles: [undefined]
    })
  })

  it('is a no-op when the binding is missing', () => {
    const tracker = new MetricsTracker(undefined, SERVER_INFO)
    expect(() => tracker.logEvent(new ToolCall({ toolName: 'execute' }))).not.toThrow()
  })

  it('records an errorCode for a tool call that failed (isError result)', () => {
    const event = new ToolCall({ userId: 'user-1', toolName: 'execute', errorCode: -1 })
    event.serverInfo = SERVER_INFO
    expect(event.toDataPoint().doubles).toEqual([-1])
  })

  it('swallows write errors so tool calls are never broken by metrics', () => {
    vi.spyOn(env.MCP_METRICS, 'writeDataPoint').mockImplementation(() => {
      throw new Error('AE down')
    })
    const tracker = new MetricsTracker(env.MCP_METRICS, SERVER_INFO)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => tracker.logEvent(new ToolCall({ toolName: 'execute' }))).not.toThrow()
    expect(errSpy).toHaveBeenCalled()
  })
})

const ACCOUNT_ID = '00000000000000000000000000000001'
const API_TOKEN = 'test-api-token-metrics'

/**
 * Worker-seam coverage for attachMetrics in src/server.ts: a real tools/call
 * for `execute` must emit a tool_call datapoint through the real MCP_METRICS
 * binding. This exercises the production emission path (userId-from-props,
 * logResult, errorCodeOf) that the unit tests above never touch.
 */
describe('tool_call emission via the real worker', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await clearKv(env.OAUTH_KV)
    await clearSpec()
  })

  function findToolCall(spy: ReturnType<typeof vi.spyOn>) {
    return (spy.mock.calls as unknown[][])
      .map(
        (args) =>
          args[0] as { indexes?: string[]; blobs?: Array<string | null>; doubles?: number[] }
      )
      .find((dp) => dp?.indexes?.[0] === 'tool_call')
  }

  it('emits a tool_call datapoint on a successful execute', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/tokens/verify`, () =>
        HttpResponse.json(cfSuccess({ id: 'token-1', status: 'active' }))
      )
    )
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')

    await callTool(API_TOKEN, 'execute', {
      code: `async () => cloudflare.request({ method: "GET", path: "/accounts/${ACCOUNT_ID}/tokens/verify" })`
    })

    const dp = findToolCall(writeSpy)
    expect(dp).toBeTruthy()
    expect(dp!.blobs?.[3]).toBe('execute') // blob4 = toolName
    expect(dp!.doubles?.[0]).toBeUndefined() // success -> no errorCode
  })

  it('records the envelope clientInfo on the Code Mode path', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    server.use(
      http.get(`${API_BASE}/accounts/${ACCOUNT_ID}/tokens/verify`, () =>
        HttpResponse.json(cfSuccess({ id: 'token-1', status: 'active' }))
      )
    )
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')

    const request = modernMcpRequest(
      API_TOKEN,
      'tools/call',
      {
        name: 'execute',
        arguments: {
          code: `async () => cloudflare.request({ method: "GET", path: "/accounts/${ACCOUNT_ID}/tokens/verify" })`
        }
      },
      { headers: { 'User-Agent': 'cursor/2.1.0' } }
    )
    await parseMcpResult(await exports.default.fetch(request))

    const dp = findToolCall(writeSpy)
    expect(dp).toBeTruthy()
    expect(dp!.blobs?.[4]).toBe('cloudflare-mcp-tests') // envelope clientInfo name, stored as-is
    expect(dp!.blobs?.[5]).toBe('1.0.0')
    expect(dp!.blobs?.[6]).toBe('modern')
    expect(dp!.blobs?.[7]).toBeFalsy() // API-token connection has no OAuth client ID
  })

  it('leaves client fields empty on a legacy direct-tools call', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')
    const base = mcpToolCallRequest(API_TOKEN, 'accounts_list', {})
    const url = new URL(base.url)
    url.searchParams.set('codemode', 'false')
    const directRequest = new Request(url, base)

    await parseMcpResult(await exports.default.fetch(directRequest))

    const dp = findToolCall(writeSpy)
    expect(dp).toBeTruthy()
    expect(dp!.blobs?.[4]).toBeFalsy() // no clientInfo on a 2025-era call
    expect(dp!.blobs?.[5]).toBeFalsy()
    expect(dp!.blobs?.[6]).toBe('legacy')
    expect(dp!.blobs?.[7]).toBeFalsy()
  })

  it('emits a tool_call datapoint from the direct tools', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')
    const base = mcpToolCallRequest(API_TOKEN, 'accounts_list', {})
    const request = new Request(`${MCP_URL}?codemode=false`, base)

    const result = await parseMcpResult(await exports.default.fetch(request))

    expect(result.result?.isError).toBeFalsy()
    const dp = findToolCall(writeSpy)
    expect(dp).toBeTruthy()
    expect(dp!.blobs?.[3]).toBe('accounts_list')
    expect(dp!.doubles?.[0]).toBeUndefined()
  })

  it('records errorCode -1 when the tool returns an isError result', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')

    // Throwing inside the executed code makes the execute tool return isError.
    await callTool(API_TOKEN, 'execute', {
      code: `async () => { throw new Error("boom") }`
    })

    const dp = findToolCall(writeSpy)
    expect(dp).toBeTruthy()
    expect(dp!.blobs?.[3]).toBe('execute')
    expect(dp!.doubles?.[0]).toBe(-1) // isError -> -1
  })
})

import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AuthUser,
  MetricsEventIndexId,
  MetricsError,
  MetricsTracker,
  ResponseSchemaMismatch,
  ToolCall,
  toolCallClient,
  userAgentProduct
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

describe('ToolCall', () => {
  it('maps a successful tool call to the correct datapoint', () => {
    const event = new ToolCall({ userId: 'user-1', toolName: 'execute' })
    event.serverInfo = SERVER_INFO
    const dp = event.toDataPoint()

    expect(dp.indexes).toEqual([MetricsEventIndexId.TOOL_CALL])
    // blob1/blob2 reserved for server name/version, blob3=userId, blob4=toolName
    expect(dp.blobs).toEqual(['cloudflare-api', '0.1.0', 'user-1', 'execute'])
    // double1 = errorCode (undefined when success)
    expect(dp.doubles).toEqual([undefined])
  })

  it('includes the errorCode for failed tool calls', () => {
    const event = new ToolCall({ userId: 'user-1', toolName: 'search', errorCode: -32602 })
    event.serverInfo = SERVER_INFO
    const dp = event.toDataPoint()

    expect(dp.doubles).toEqual([-32602])
  })

  it('puts the client in blob5-blob11, keeping the shared slots in place', () => {
    const event = new ToolCall({
      userId: 'user-1',
      toolName: 'execute',
      client: {
        name: 'claude-code',
        version: '2.1.0',
        userAgent: 'claude-code/2.1.0',
        protocol: '2026-07-28',
        mode: 'codemode',
        connection: 'oauth',
        oauthClientId: 'https://claude.ai/oauth/client.json'
      }
    })
    event.serverInfo = SERVER_INFO

    expect(event.toDataPoint().blobs).toEqual([
      'cloudflare-api',
      '0.1.0',
      'user-1',
      'execute',
      'claude-code', // blob5 client name
      '2.1.0', // blob6 client version
      'claude-code/2.1.0', // blob7 User-Agent product
      '2026-07-28', // blob8 protocol
      'codemode', // blob9 tool mode
      'oauth', // blob10 connection kind
      'https://claude.ai/oauth/client.json' // blob11 OAuth client ID
    ])
  })

  it('writes null for client fields it does not know', () => {
    const event = new ToolCall({
      toolName: 'execute',
      client: { protocol: '2025', mode: 'direct', connection: 'direct' }
    })
    event.serverInfo = SERVER_INFO

    expect(event.toDataPoint().blobs).toEqual([
      'cloudflare-api',
      '0.1.0',
      null,
      'execute',
      null,
      null,
      null,
      '2025',
      'direct',
      'direct',
      null
    ])
  })
})

describe('userAgentProduct', () => {
  it('keeps only the first product token', () => {
    expect(userAgentProduct('claude-code/2.1.0 (darwin; arm64) node/22')).toBe('claude-code/2.1.0')
    expect(userAgentProduct('  Cursor/1.2  ')).toBe('Cursor/1.2')
  })

  it('returns undefined for a missing or blank User-Agent', () => {
    expect(userAgentProduct(null)).toBeUndefined()
    expect(userAgentProduct('   ')).toBeUndefined()
  })

  it('caps the token at 128 characters', () => {
    expect(userAgentProduct('x'.repeat(500))).toHaveLength(128)
  })
})

describe('toolCallClient', () => {
  const request = {
    mode: 'codemode',
    connection: 'oauth',
    userAgent: 'node/22.1.0',
    oauthClientId: 'abc'
  } as const

  function contextWith(envelope: Record<string, unknown> | undefined) {
    return { mcpReq: { envelope } } as unknown as Parameters<typeof toolCallClient>[1]
  }

  it('prefers the 2026-07-28 envelope clientInfo and protocol version', () => {
    const ctx = contextWith({
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'Claude Code', version: '2.1.0' }
    })

    expect(toolCallClient(request, ctx)).toEqual({
      name: 'Claude Code',
      version: '2.1.0',
      userAgent: 'node/22.1.0',
      protocol: '2026-07-28',
      mode: 'codemode',
      connection: 'oauth',
      oauthClientId: 'abc'
    })
  })

  it('falls back to the User-Agent for a 2025-era call', () => {
    expect(toolCallClient(request, contextWith(undefined))).toMatchObject({
      name: 'node',
      version: '22.1.0',
      protocol: '2025'
    })
  })

  it('tolerates a missing context and a non-string clientInfo', () => {
    expect(toolCallClient({ mode: 'direct', connection: 'direct' })).toEqual({
      name: undefined,
      version: undefined,
      userAgent: undefined,
      protocol: '2025',
      mode: 'direct',
      connection: 'direct',
      oauthClientId: undefined
    })
    const ctx = contextWith({ 'io.modelcontextprotocol/clientInfo': { name: 42 } })
    expect(toolCallClient(request, ctx).name).toBe('node')
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
      blobs: ['cloudflare-api', '0.1.0', 'user-1', 'execute'],
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

  it('names a 2025-era client by its User-Agent', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')
    const base = mcpToolCallRequest(API_TOKEN, 'accounts_list', {})
    base.headers.set('User-Agent', 'opencode/1.4.2 (darwin)')
    const request = new Request(`${MCP_URL}?codemode=false`, base)

    await parseMcpResult(await exports.default.fetch(request))

    // blob5..blob11: name, version, UA product, protocol, mode, connection, OAuth client
    expect(findToolCall(writeSpy)!.blobs?.slice(4)).toEqual([
      'opencode',
      '1.4.2',
      'opencode/1.4.2',
      '2025',
      'direct',
      'direct',
      null
    ])
  })

  it('names a 2026-07-28 client by its envelope clientInfo', async () => {
    mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Acc' }] })
    const writeSpy = vi.spyOn(env.MCP_METRICS, 'writeDataPoint')

    await exports.default.fetch(
      modernMcpRequest(
        API_TOKEN,
        'tools/call',
        { name: 'execute', arguments: { code: 'async () => 1' } },
        { headers: { 'User-Agent': 'node' } }
      )
    )

    expect(findToolCall(writeSpy)!.blobs?.slice(4)).toEqual([
      'cloudflare-mcp-tests',
      '1.0.0',
      'node',
      '2026-07-28',
      'codemode',
      'direct',
      null
    ])
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

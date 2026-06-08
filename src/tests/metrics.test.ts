import { describe, expect, it, vi } from 'vitest'
import { AuthUser, MetricsEventIndexId, MetricsError, MetricsTracker, ToolCall } from '../metrics'

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
  it('writes a datapoint with server info injected', () => {
    const writeDataPoint = vi.fn()
    const tracker = new MetricsTracker(
      { writeDataPoint } as unknown as AnalyticsEngineDataset,
      SERVER_INFO
    )

    tracker.logEvent(new ToolCall({ userId: 'user-1', toolName: 'execute' }))

    expect(writeDataPoint).toHaveBeenCalledTimes(1)
    expect(writeDataPoint).toHaveBeenCalledWith({
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
    const writeDataPoint = vi.fn(() => {
      throw new Error('AE down')
    })
    const tracker = new MetricsTracker(
      { writeDataPoint } as unknown as AnalyticsEngineDataset,
      SERVER_INFO
    )
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => tracker.logEvent(new ToolCall({ toolName: 'execute' }))).not.toThrow()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

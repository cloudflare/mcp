/**
 * MCP metrics tracking via Analytics Engine.
 *
 * Mirrors the schema used by the per-product Cloudflare MCP servers
 * (`@repo/mcp-observability` in cloudflare/mcp-server-cloudflare) so that
 * datapoints written here land in the shared `mcp-metrics-*` dataset alongside
 * the other servers and are picked up by existing dashboards/queries.
 *
 * Positional layout (must not change — the dataset columns are positional):
 *   index1  = event type (`tool_call` | `auth_user`)
 *   blob1   = MCP server name      (reserved, injected by the tracker)
 *   blob2   = MCP server version   (reserved, injected by the tracker)
 *   blob3   = userId
 *   blob4   = toolName (tool_call) | errorMessage (auth_user)
 *   double1 = errorCode (tool_call)
 *
 * Note: this server is stateless (a fresh McpServer per request) so it does not
 * emit `session_start` events the way the Durable-Object-backed Cloudflare MCP
 * servers do — `oninitialized` fires on a separate request from `initialize`
 * and can never observe the client info. The `blob4`/`blob5`/`double2` slots
 * reserved upstream for session client info are simply left unused here, which
 * keeps shared-dataset queries compatible. Client identity is available at the
 * HTTP layer via the User-Agent header instead.
 */

import { env } from 'cloudflare:workers'
import type { McpServer } from '@modelcontextprotocol/server'
import type { AuthProps } from './auth/types'
import { SERVER_INFO, type ServerInfo } from './constants'

export enum MetricsEventIndexId {
  AUTH_USER = 'auth_user',
  TOOL_CALL = 'tool_call'
}

type Range1To20 =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20

// blob1 and blob2 are reserved for server name and version
type Blobs = { [key in `blob${Range1To20}`]?: string | null }
type Doubles = { [key in `double${Range1To20}`]?: number }

export class MetricsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetricsError'
  }
}

/**
 * Each event type is stored with a different index id and maps an ergonomic
 * event object to an AnalyticsEngineDataPoint.
 */
export abstract class MetricsEvent {
  private _serverInfo: ServerInfo | undefined

  set serverInfo(serverInfo: ServerInfo) {
    this._serverInfo = serverInfo
  }

  get serverInfo(): ServerInfo {
    if (!this._serverInfo) {
      throw new MetricsError('Server info not set')
    }
    return this._serverInfo
  }

  abstract toDataPoint(): AnalyticsEngineDataPoint

  /**
   * Map a named blob object to a positional array. blob1/blob2 are reserved for
   * the MCP server name/version and are filled in here.
   */
  mapBlobs(blobs: Blobs): Array<string | null> {
    if (blobs.blob1 || blobs.blob2) {
      throw new MetricsError(
        'Failed to map blobs, blob1 and blob2 are reserved for MCP server info'
      )
    }
    blobs.blob1 = this.serverInfo.name
    blobs.blob2 = this.serverInfo.version
    const blobsArray: Array<string | null> = Array.from({ length: Object.keys(blobs).length })
    for (const [key, value] of Object.entries(blobs)) {
      const match = key.match(/^blob(\d+)$/)
      if (match === null || match.length < 2) {
        throw new MetricsError('Failed to map blobs, invalid key')
      }
      const index = parseInt(match[1], 10)
      if (isNaN(index)) {
        throw new MetricsError('Failed to map blobs, invalid index')
      }
      if (index - 1 >= blobsArray.length) {
        throw new MetricsError('Failed to map blobs, missing blob')
      }
      blobsArray[index - 1] = value ?? null
    }
    return blobsArray
  }

  mapDoubles(doubles: Doubles): number[] {
    const doublesArray: number[] = Array.from({ length: Object.keys(doubles).length })
    for (const [key, value] of Object.entries(doubles)) {
      const match = key.match(/^double(\d+)$/)
      if (match === null || match.length < 2) {
        throw new MetricsError('Failed to map doubles, invalid key')
      }
      const index = parseInt(match[1], 10)
      if (isNaN(index)) {
        throw new MetricsError('Failed to map doubles, invalid index')
      }
      if (index - 1 >= doublesArray.length) {
        throw new MetricsError('Failed to map doubles, missing double')
      }
      doublesArray[index - 1] = value as number
    }
    return doublesArray
  }
}

export class ToolCall extends MetricsEvent {
  constructor(
    private toolCall: {
      userId?: string
      toolName: string
      errorCode?: number
    }
  ) {
    super()
  }

  toDataPoint(): AnalyticsEngineDataPoint {
    return {
      indexes: [MetricsEventIndexId.TOOL_CALL],
      blobs: this.mapBlobs({
        blob3: this.toolCall.userId,
        blob4: this.toolCall.toolName
      }),
      doubles: this.mapDoubles({
        double1: this.toolCall.errorCode
      })
    }
  }
}

export class AuthUser extends MetricsEvent {
  constructor(
    private authUser: {
      userId?: string
      errorMessage?: string
    }
  ) {
    super()
  }

  toDataPoint(): AnalyticsEngineDataPoint {
    return {
      indexes: [MetricsEventIndexId.AUTH_USER],
      blobs: this.mapBlobs({
        blob3: this.authUser.userId,
        blob4: this.authUser.errorMessage
      })
    }
  }
}

/**
 * Wraps the Analytics Engine binding. Tolerates a missing binding (e.g. in
 * tests or local dev where MCP_METRICS isn't configured) by becoming a no-op.
 */
export class MetricsTracker {
  constructor(
    private wae: AnalyticsEngineDataset | undefined,
    private serverInfo: ServerInfo
  ) {}

  logEvent(event: MetricsEvent): void {
    if (!this.wae) return
    try {
      event.serverInfo = this.serverInfo
      this.wae.writeDataPoint(event.toDataPoint())
    } catch (e) {
      console.error(`Failed to log metrics event, ${e}`)
    }
  }
}

/**
 * Resolve the userId to attribute metrics to. Only user tokens carry a user
 * identity; account tokens have no user, so blob3 is left undefined — matching
 * the other Cloudflare MCP servers (`props.type === 'user_token' ? ... : undefined`).
 */
function userIdFromProps(props?: AuthProps): string | undefined {
  return props?.type === 'user_token' ? props.user.id : undefined
}

/** Record one tool call from a low-level protocol handler. */
export function recordToolCall(props: AuthProps, toolName: string, isError: boolean): void {
  const metrics = new MetricsTracker(env.MCP_METRICS, SERVER_INFO)
  metrics.logEvent(
    new ToolCall({
      toolName,
      userId: userIdFromProps(props),
      errorCode: isError ? -1 : undefined
    })
  )
}

/**
 * Wire Analytics Engine metrics into a server instance: log a `tool_call` for
 * every tool invocation (with an `errorCode` on failure). Monkey-patches
 * `registerTool` so every tool registered after this call is tracked
 * identically. Tolerant of a missing MCP_METRICS binding (becomes a no-op).
 *
 * Note: unlike the Durable-Object-backed Cloudflare MCP servers, this server is
 * stateless (a fresh McpServer per request), so there is no meaningful
 * `session_start` to log — `oninitialized` fires on a separate request from the
 * `initialize` handshake and can never see the client info. Client identity is
 * instead available at the HTTP layer via the User-Agent header.
 */
export function attachMetrics(server: McpServer, props?: AuthProps): void {
  const metrics = new MetricsTracker(env.MCP_METRICS, SERVER_INFO)
  const userId = userIdFromProps(props)

  const errorCodeOf = (e: unknown): number =>
    typeof (e as { code?: unknown })?.code === 'number' ? (e as { code: number }).code : -1

  // Our tool callbacks signal failure by returning `{ isError: true }` rather
  // than throwing, so inspect the resolved result as well as the thrown path.
  const logResult = (name: string, result: unknown) => {
    const errorCode = (result as { isError?: boolean })?.isError ? -1 : undefined
    metrics.logEvent(new ToolCall({ toolName: name, userId, errorCode }))
  }

  const originalRegisterTool = server.registerTool.bind(server) as (
    ...args: unknown[]
  ) => ReturnType<McpServer['registerTool']>

  server.registerTool = ((name: string, ...rest: unknown[]) => {
    const lastIndex = rest.length - 1
    const cb = rest[lastIndex] as (...cbArgs: unknown[]) => unknown
    rest[lastIndex] = (...cbArgs: unknown[]) => {
      try {
        const out = cb(...cbArgs)
        if (out instanceof Promise) {
          return out
            .then((r) => {
              logResult(name, r)
              return r
            })
            .catch((e: unknown) => {
              metrics.logEvent(new ToolCall({ toolName: name, userId, errorCode: errorCodeOf(e) }))
              throw e
            })
        }
        logResult(name, out)
        return out
      } catch (e) {
        metrics.logEvent(new ToolCall({ toolName: name, userId, errorCode: errorCodeOf(e) }))
        throw e
      }
    }
    return originalRegisterTool(name, ...rest)
  }) as McpServer['registerTool']
}

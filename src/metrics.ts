/**
 * MCP metrics tracking via Analytics Engine.
 *
 * Mirrors the schema used by the per-product Cloudflare MCP servers
 * (`@repo/mcp-observability` in cloudflare/mcp-server-cloudflare) so that
 * datapoints written here land in the shared `mcp-metrics-*` dataset alongside
 * the other servers and are picked up by existing dashboards/queries.
 *
 * Positional layout (must not change — the dataset columns are positional):
 *   index1  = event type (`tool_call` | `auth_user` | `response_schema_mismatch`)
 *   blob1   = MCP server name      (reserved, injected by the tracker)
 *   blob2   = MCP server version   (reserved, injected by the tracker)
 *   blob3   = userId
 *   blob4   = toolName (tool_call, response_schema_mismatch) | errorMessage (auth_user)
 *   double1 = errorCode (tool_call; always 0 for response_schema_mismatch)
 *
 * `response_schema_mismatch` (a direct-tool response that doesn't match its
 * OpenAPI response schema, see `src/response-validation.ts`) adds:
 *   blob5   = HTTP method (`GET`)
 *   blob6   = OpenAPI path template (`/zones/{zone_id}/dns_records`)
 *   blob7   = product (path segment after `{account_id}`/`{zone_id}`, else the first)
 *   blob8   = generated forge tool whose response schema was used
 *   blob9   = response key whose schema was used (`200`, `4XX`, `default`)
 *   blob10  = first violation's keyword (`type`, `required`, `enum`, …)
 *   blob11  = first violation's schema location
 *             (`#/components/schemas/<name>/…` or `#/responses/<key>/schema/…`)
 *   blob12  = first violation's instance path, indices and undeclared keys as `*`
 *   blob13  = OpenAPI release the generated schemas came from (`openapi@<forge commit>`)
 *   double2 = HTTP status
 *   double3 = number of violations
 *   double4 = sample interval (1 / RESPONSE_VALIDATION_SAMPLE_RATE); weight counts by it
 *   double5 = 1 if double3 counts every violation, 0 if it is a lower bound
 *             (arrays past 25 items unchecked, or too large to count)
 * No blob holds a response value: those are customer data.
 *
 * Note: this server is stateless (a fresh McpServer per request) so it does not
 * emit `session_start` events the way the Durable-Object-backed Cloudflare MCP
 * servers do. MCP 2026-07-28 has no protocol session or initialize handshake;
 * the 2025 compatibility path also retains no initialization state between
 * requests. The slots reserved upstream for session client info remain unused,
 * keeping shared-dataset queries compatible. Client identity is available at
 * the HTTP layer via the User-Agent header instead.
 */

import { env } from 'cloudflare:workers'
import type { McpServer } from '@modelcontextprotocol/server'
import type { AuthProps } from './auth/types'
import { SERVER_INFO, type ServerInfo } from './constants'

export enum MetricsEventIndexId {
  AUTH_USER = 'auth_user',
  TOOL_CALL = 'tool_call',
  RESPONSE_SCHEMA_MISMATCH = 'response_schema_mismatch'
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

export interface ResponseSchemaMismatchFields {
  userId?: string
  toolName: string
  method: string
  pathTemplate: string
  product: string
  /** The generated forge tool whose response schema was used. */
  forgeTool: string
  responseKey: string
  /** The OpenAPI release tag the schema came from, or `null` when unknown. */
  specRelease: string | null
  status: number
  errorCount: number
  /** Whether `errorCount` is every violation rather than a lower bound. */
  counted: boolean
  sampleInterval: number
  first: { keyword: string; schemaLocation: string; instancePath: string }
}

export class ResponseSchemaMismatch extends MetricsEvent {
  constructor(private mismatch: ResponseSchemaMismatchFields) {
    super()
  }

  toDataPoint(): AnalyticsEngineDataPoint {
    const { mismatch } = this
    return {
      indexes: [MetricsEventIndexId.RESPONSE_SCHEMA_MISMATCH],
      blobs: this.mapBlobs({
        blob3: mismatch.userId,
        blob4: mismatch.toolName,
        blob5: mismatch.method,
        blob6: mismatch.pathTemplate,
        blob7: mismatch.product,
        blob8: mismatch.forgeTool,
        blob9: mismatch.responseKey,
        blob10: mismatch.first.keyword,
        blob11: mismatch.first.schemaLocation,
        blob12: mismatch.first.instancePath,
        blob13: mismatch.specRelease
      }),
      doubles: this.mapDoubles({
        double1: 0,
        double2: mismatch.status,
        double3: mismatch.errorCount,
        double4: mismatch.sampleInterval,
        double5: mismatch.counted ? 1 : 0
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

/** Record one direct-tool response that didn't match its OpenAPI response schema. */
export function recordResponseSchemaMismatch(
  props: AuthProps,
  mismatch: Omit<ResponseSchemaMismatchFields, 'userId'>
): void {
  const metrics = new MetricsTracker(env.MCP_METRICS, SERVER_INFO)
  metrics.logEvent(new ResponseSchemaMismatch({ ...mismatch, userId: userIdFromProps(props) }))
}

/**
 * Wire Analytics Engine metrics into a server instance: log a `tool_call` for
 * every tool invocation (with an `errorCode` on failure). Monkey-patches
 * `registerTool` so every tool registered after this call is tracked
 * identically. Tolerant of a missing MCP_METRICS binding (becomes a no-op).
 *
 * Note: unlike the Durable-Object-backed Cloudflare MCP servers, this server is
 * stateless (a fresh McpServer per request), so there is no meaningful
 * `session_start` to log. Modern MCP has no initialize handshake, and the
 * stateless 2025 fallback retains no client lifecycle between requests. Client
 * identity is instead available at the HTTP layer via the User-Agent header.
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
    const config = rest[0] as { title?: string; annotations?: { title?: string } } | undefined
    // Mirror any tool.title into annotations.title so clients consistently see
    // a display label regardless of which field they prefer.
    if (config?.title && config.annotations && config.annotations.title === undefined) {
      config.annotations.title = config.title
    }

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

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
 * `tool_call` adds who made the call (see {@link ToolCallClient}), so usage can
 * be broken down by harness:
 *   blob5   = client name: the 2026-07-28 `_meta` clientInfo name, else the
 *             User-Agent's product name
 *   blob6   = client version, from the same source as blob5
 *   blob7   = User-Agent's first product token (`claude-code/2.1.0`)
 *   blob8   = protocol: the 2026-07-28 envelope's protocol version, else `2025`
 *   blob9   = tool mode (`codemode` | `direct`)
 *   blob10  = connection kind (`oauth` | `direct`)
 * Events written before these fields existed leave them empty. The OAuth
 * client ID is left out: a registered one is a stable per-installation ID,
 * and blob5–blob7 already name the client.
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
 * requests. There is no `session_start` to carry client info, so each
 * `tool_call` carries it instead (blob5–blob10).
 */

import { env } from 'cloudflare:workers'
import { CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server'
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import type { AuthProps } from './auth/types'
import { SERVER_INFO } from './constants'
import type { ServerInfo } from './constants'

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
      const index = Number.parseInt(match[1], 10)
      if (Number.isNaN(index)) {
        throw new MetricsError('Failed to map blobs, invalid index')
      }
      if (index - 1 >= blobsArray.length) {
        throw new MetricsError('Failed to map blobs, missing blob')
      }
      blobsArray[index - 1] = value ?? null
    }
    return blobsArray
  }

  mapDoubles(doubles: Doubles): Array<number> {
    const doublesArray: Array<number> = Array.from({ length: Object.keys(doubles).length })
    for (const [key, value] of Object.entries(doubles)) {
      const match = key.match(/^double(\d+)$/)
      if (match === null || match.length < 2) {
        throw new MetricsError('Failed to map doubles, invalid key')
      }
      const index = Number.parseInt(match[1], 10)
      if (Number.isNaN(index)) {
        throw new MetricsError('Failed to map doubles, invalid index')
      }
      if (index - 1 >= doublesArray.length) {
        throw new MetricsError('Failed to map doubles, missing double')
      }
      doublesArray[index - 1] = value
    }
    return doublesArray
  }
}

/** Who made a tool call: the client, its protocol, the tool mode and the credential. */
export interface ToolCallClient {
  readonly name?: string
  readonly version?: string
  readonly userAgent?: string
  readonly protocol: string
  readonly mode: 'codemode' | 'direct'
  readonly connection: 'oauth' | 'direct'
}

export class ToolCall extends MetricsEvent {
  constructor(
    private toolCall: {
      userId?: string
      toolName: string
      errorCode?: number
      client?: ToolCallClient
    }
  ) {
    super()
  }

  toDataPoint(): AnalyticsEngineDataPoint {
    const { client } = this.toolCall
    return {
      indexes: [MetricsEventIndexId.TOOL_CALL],
      blobs: this.mapBlobs({
        blob3: this.toolCall.userId,
        blob4: this.toolCall.toolName,
        ...(client && {
          blob5: client.name,
          blob6: client.version,
          blob7: client.userAgent,
          blob8: client.protocol,
          blob9: client.mode,
          blob10: client.connection
        })
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
    if (!this.wae) {
      return
    }
    try {
      event.serverInfo = this.serverInfo
      this.wae.writeDataPoint(event.toDataPoint())
    } catch (error) {
      console.error(`Failed to log metrics event, ${String(error)}`)
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

/**
 * What the HTTP request says about its client, the same for every tool call in
 * it. Built once per request in `src/mcp-handler.ts`.
 */
export interface RequestClient {
  readonly mode: ToolCallClient['mode']
  readonly connection: ToolCallClient['connection']
  /** The User-Agent's first product token, from {@link userAgentProduct}. */
  readonly userAgent?: string
}

const MAX_CLIENT_FIELD = 128

function clientField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, MAX_CLIENT_FIELD) : undefined
}

/**
 * The first product token of a User-Agent (`claude-code/2.1.0 (darwin)` →
 * `claude-code/2.1.0`). The rest, such as the OS and platform, is left out.
 */
export function userAgentProduct(userAgent: string | null | undefined): string | undefined {
  return clientField(userAgent?.trim().split(/\s+/, 1)[0])
}

/**
 * Who made one tool call. A 2026-07-28 request names its client and protocol
 * in its `_meta` envelope. A 2025-era request names its client only in
 * `initialize`, which is a request of its own here, so its User-Agent stands in.
 */
export function toolCallClient(request: RequestClient, ctx?: ServerContext): ToolCallClient {
  const envelope = ctx?.mcpReq?.envelope as Record<string, unknown> | undefined
  const info = envelope?.[CLIENT_INFO_META_KEY] as { name?: unknown; version?: unknown } | undefined
  const protocol = clientField(envelope?.[PROTOCOL_VERSION_META_KEY]) ?? '2025'
  const name = clientField(info?.name)
  const [uaName, uaVersion] = request.userAgent?.split('/', 2) ?? []
  return {
    name: name ?? clientField(uaName),
    version: name ? clientField(info?.version) : clientField(uaVersion),
    userAgent: request.userAgent,
    protocol,
    mode: request.mode,
    connection: request.connection
  }
}

/** Record one tool call from a low-level protocol handler. */
export function recordToolCall(
  props: AuthProps,
  toolName: string,
  isError: boolean,
  client?: ToolCallClient
): void {
  const metrics = new MetricsTracker(env.MCP_METRICS, SERVER_INFO)
  metrics.logEvent(
    new ToolCall({
      toolName,
      userId: userIdFromProps(props),
      errorCode: isError ? -1 : undefined,
      client
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

function errorCodeOf(error: unknown): number {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = error.code
    if (typeof code === 'number') {
      return code
    }
  }
  return -1
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
 * stateless 2025 fallback retains no client lifecycle between requests. Each
 * `tool_call` names its client instead, from `request` and the call's context.
 */
export function attachMetrics(server: McpServer, props?: AuthProps, request?: RequestClient): void {
  const metrics = new MetricsTracker(env.MCP_METRICS, SERVER_INFO)
  const userId = userIdFromProps(props)

  // The SDK passes the call's context last: `(args, ctx)`, or `(ctx)` for a tool without input.
  const clientOf = (cbArgs: Array<unknown>): ToolCallClient | undefined =>
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The SDK always passes its ServerContext as the last callback argument.
    request && toolCallClient(request, cbArgs.at(-1) as ServerContext | undefined)

  const log = (name: string, cbArgs: Array<unknown>, errorCode: number | undefined) =>
    metrics.logEvent(new ToolCall({ toolName: name, userId, errorCode, client: clientOf(cbArgs) }))

  // Our tool callbacks signal failure by returning `{ isError: true }` rather
  // than throwing, so inspect the resolved result as well as the thrown path.
  const logResult = (name: string, cbArgs: Array<unknown>, result: unknown) => {
    const failed =
      result !== null && typeof result === 'object' && 'isError' in result && result.isError
    log(name, cbArgs, failed ? -1 : undefined)
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The metrics wrapper preserves the SDK's runtime registration contract.
  const originalRegisterTool = server.registerTool.bind(server) as (
    ...args: Array<unknown>
  ) => ReturnType<McpServer['registerTool']>

  server.registerTool = (name: string, ...rest: Array<unknown>) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The metrics wrapper preserves the SDK's runtime registration contract.
    const config = rest[0] as { title?: string; annotations?: { title?: string } } | undefined
    // Mirror any tool.title into annotations.title so clients consistently see
    // a display label regardless of which field they prefer.
    if (config?.title && config.annotations && config.annotations.title === undefined) {
      config.annotations.title = config.title
    }

    const lastIndex = rest.length - 1
    // oxlint-disable-next-line quality/no-unknown-returns, typescript/no-unsafe-type-assertion -- The metrics wrapper forwards the SDK callback result unchanged.
    const cb = rest[lastIndex] as (...cbArgs: Array<unknown>) => unknown
    rest[lastIndex] = (...cbArgs: Array<unknown>) => {
      try {
        const out = cb(...cbArgs)
        // oxlint-disable-next-line @nkzw/no-instanceof -- Preserve the SDK callback's synchronous and promise results.
        if (out instanceof Promise) {
          return out
            .then((r: unknown) => {
              logResult(name, cbArgs, r)
              return r
            })
            .catch((error: unknown) => {
              log(name, cbArgs, errorCodeOf(error))
              throw error
            })
        }
        logResult(name, cbArgs, out)
        return out
      } catch (error) {
        log(name, cbArgs, errorCodeOf(error))
        throw error
      }
    }
    return originalRegisterTool(name, ...rest)
  }
}

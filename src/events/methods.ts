import { ProtocolError, type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { AuthProps } from '../auth/types'
import { EventApiError } from './api'
import { SubscribeParams, UnsubscribeParams } from './ans-bridge'
import { CallbackError, EventNotFound, EventService, SubscriptionForbidden } from './service'
import type { EventEnvironment } from './state'

const Meta = z.record(z.string(), z.unknown()).optional()

// Built once per isolate: the server, and so these methods, are registered for every request.
const ListParams = z
  .object({
    cursor: z
      .string()
      .regex(/^[1-9][0-9]{0,3}$/)
      .optional(),
    _meta: Meta
  })
  .strict()
const SubscribeRequestParams = SubscribeParams.extend({ _meta: Meta })
const UnsubscribeRequestParams = UnsubscribeParams.extend({ _meta: Meta })

/** Error codes from the MCP Events draft (implementation-defined server range). */
const NOT_FOUND = -32011
const FORBIDDEN = -32012
const CALLBACK_ENDPOINT_ERROR = -32015
const INTERNAL_ERROR = -32603

/** Project service failures onto the draft's JSON-RPC error codes. */
async function operation<T>(run: () => Promise<T>) {
  try {
    return await run()
  } catch (error) {
    if (error instanceof CallbackError)
      throw new ProtocolError(CALLBACK_ENDPOINT_ERROR, 'CallbackEndpointError', {
        reason: error.reason
      })
    if (error instanceof EventNotFound)
      throw new ProtocolError(NOT_FOUND, 'NotFound', { kind: 'event' })
    if (error instanceof SubscriptionForbidden)
      throw new ProtocolError(FORBIDDEN, 'Forbidden', { reason: error.message })
    if (error instanceof EventApiError && (error.status === 401 || error.status === 403))
      throw new ProtocolError(FORBIDDEN, 'Forbidden', { reason: error.message })
    if (error instanceof EventApiError)
      throw new ProtocolError(INTERNAL_ERROR, error.message, { status: error.status })
    throw new ProtocolError(
      INTERNAL_ERROR,
      'Subscription operation failed. Retry with current credentials; partially created resources will be reused.'
    )
  }
}

/**
 * Register the MCP Events webhook methods (`events/list`, `events/subscribe`,
 * `events/unsubscribe`) and advertise the `events` capability.
 *
 * @param server - The per-request MCP server.
 * @param env - Bindings used for subscription state and the Cloudflare API.
 * @param props - The authenticated principal.
 * @param bearer - The MCP bearer token for this request.
 */
export function registerEventMethods(
  server: McpServer,
  env: EventEnvironment,
  props: AuthProps,
  bearer: string
) {
  const service = new EventService(env, props, bearer)
  // The catalogue is fixed per deployment, so no notifications/events/list_changed.
  // The SDK's capability type does not know the draft's `events` key yet. A
  // named value skips the excess-property check; the SDK merges it as-is.
  const capabilities = { ...server.server.getCapabilities(), events: { listChanged: false } }
  server.server.registerCapabilities(capabilities)
  server.server.setRequestHandler('events/list', { params: ListParams }, async (params) => {
    const result = await operation(() => service.list(params.cursor))
    console.log(
      JSON.stringify({
        event: 'mcp_events_list',
        principal: props.type,
        events: result.events.length,
        nextCursor: 'nextCursor' in result
      })
    )
    return result
  })
  server.server.setRequestHandler(
    'events/subscribe',
    { params: SubscribeRequestParams },
    ({ _meta, ...params }) => operation(() => service.subscribe(params))
  )
  server.server.setRequestHandler(
    'events/unsubscribe',
    { params: UnsubscribeRequestParams },
    ({ _meta, ...params }) => operation(() => service.unsubscribe(params))
  )
}

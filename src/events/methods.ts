import { ProtocolError, type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { AuthProps } from '../auth/types'
import { EventApiError } from './api'
import { SubscribeParams, UnsubscribeParams } from './ans-bridge'
import { CallbackError, EventService } from './service'
import type { EventEnvironment } from './state'

const Meta = z.record(z.string(), z.unknown()).optional()

async function operation<T>(run: () => Promise<T>) {
  try {
    return await run()
  } catch (error) {
    if (error instanceof CallbackError)
      throw new ProtocolError(-32015, error.message, { reason: 'challenge_failed' })
    if (error instanceof EventApiError)
      throw new ProtocolError(-32000, error.message, { status: error.status })
    throw new ProtocolError(
      -32000,
      'Subscription operation failed. Retry with current credentials; partially created resources will be reused.'
    )
  }
}

export function registerEventMethods(
  server: McpServer,
  env: EventEnvironment,
  props: AuthProps,
  bearer: string
) {
  const service = new EventService(env, props, bearer)
  const capabilities = { ...server.server.getCapabilities(), events: {} }
  server.server.registerCapabilities(capabilities)
  server.server.setRequestHandler(
    'events/list',
    {
      params: z
        .object({
          cursor: z
            .string()
            .regex(/^[1-9][0-9]{0,3}$/)
            .optional(),
          _meta: Meta
        })
        .strict()
    },
    (params) => operation(() => service.list(params.cursor))
  )
  server.server.setRequestHandler(
    'events/subscribe',
    {
      params: SubscribeParams.extend({ _meta: Meta })
    },
    ({ _meta, ...params }) => operation(() => service.subscribe(params))
  )
  server.server.setRequestHandler(
    'events/unsubscribe',
    {
      params: UnsubscribeParams.extend({ _meta: Meta })
    },
    ({ _meta, ...params }) => operation(() => service.unsubscribe(params))
  )
}

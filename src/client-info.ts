import { CLIENT_INFO_META_KEY, type ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'

/** The MCP protocol's client identity: self-reported name and version. */
export interface ClientInfo {
  readonly name: string
  readonly version?: string
}

const ClientInfoSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    version: z.string().trim().max(32).optional()
  })
  .passthrough()

/** Validate a protocol `clientInfo` value, bounded so it can be stored as-is. */
export function parseClientInfo(value: unknown): ClientInfo | undefined {
  const parsed = ClientInfoSchema.safeParse(value)
  return parsed.success ? { name: parsed.data.name, version: parsed.data.version } : undefined
}

/** Read the per-request `clientInfo` from a tool call's `_meta` envelope. */
export function clientInfoFromContext(ctx: ServerContext | undefined): ClientInfo | undefined {
  const envelope = (ctx?.mcpReq.envelope ?? {}) as Record<string, unknown>
  return parseClientInfo(envelope[CLIENT_INFO_META_KEY])
}

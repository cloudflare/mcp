import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type Tool
} from '@modelcontextprotocol/server'
import { MCP_APP_MIME } from './define'

/** The MCP Apps extension a host declares in its capabilities, and this server in its own. */
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Whether a request's client declares that it renders MCP Apps: a 2026-07-28
 * request whose `_meta` envelope lists `text/html;profile=mcp-app` under
 * `extensions["io.modelcontextprotocol/ui"].mimeTypes`.
 *
 * 2025-era requests send capabilities only in `initialize`, which a stateless
 * server never sees again, so they always count as not declaring it. Production
 * logs (November 2026) put 98% of `tools/list` requests, and nearly all of
 * Claude's and ChatGPT's, on 2026-07-28.
 *
 * @param body - The parsed JSON-RPC body, or `undefined` when it wasn't read.
 */
export function declaresMcpApps(body: unknown): boolean {
  const meta = record(record(record(body)?.params)?._meta)
  if (typeof meta?.[PROTOCOL_VERSION_META_KEY] !== 'string') return false
  const extensions = record(record(meta[CLIENT_CAPABILITIES_META_KEY])?.extensions)
  const mimeTypes = record(extensions?.[MCP_APPS_EXTENSION_ID])?.mimeTypes
  return Array.isArray(mimeTypes) && mimeTypes.includes(MCP_APP_MIME)
}

/** The client's name from a 2026-07-28 envelope, for logging which hosts declare Apps. */
export function envelopeClientName(body: unknown): string | undefined {
  const meta = record(record(record(body)?.params)?._meta)
  const name = record(meta?.['io.modelcontextprotocol/clientInfo'])?.name
  return typeof name === 'string' ? name : undefined
}

/**
 * An App's tool as a client without MCP Apps lists it: a plain tool whose
 * result is the same JSON text, without the `_meta` that links it to its view.
 */
export function withoutAppView(tool: Tool): Tool {
  if (!tool._meta) return tool
  const { ui: _ui, 'ui/resourceUri': _uri, ...meta } = tool._meta
  const { _meta: _dropped, ...rest } = tool
  return Object.keys(meta).length > 0 ? { ...rest, _meta: meta } : rest
}

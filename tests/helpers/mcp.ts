import { exports } from 'cloudflare:workers'

export const MCP_URL = 'https://mcp.cloudflare.com/mcp'
export const MCP_HOST = 'mcp.cloudflare.com'
export const MODERN_MCP_VERSION = '2026-07-28'

/** Result envelope of an MCP request over Streamable HTTP. */
export interface McpToolResult {
  result?: {
    resultType?: string
    supportedVersions?: string[]
    serverInfo?: { name: string; version: string }
    content?: Array<{ type: string; text: string }>
    isError?: boolean
    tools?: Array<{
      name: string
      title?: string
      annotations?: { title?: string; readOnlyHint?: boolean }
    }>
  }
  error?: { code: number; message: string }
}

/** Build a legacy JSON-RPC `tools/list` request to the worker's `/mcp` endpoint. */
export function mcpToolListRequest(token: string, id = 1): Request {
  return new Request(MCP_URL, {
    method: 'POST',
    headers: {
      Host: MCP_HOST,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })
  })
}

/** Build a legacy JSON-RPC `tools/call` request to the worker's `/mcp` endpoint. */
export function mcpToolCallRequest(
  token: string,
  name: string,
  args: Record<string, unknown>,
  id = 1
): Request {
  return new Request(MCP_URL, {
    method: 'POST',
    headers: {
      Host: MCP_HOST,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // Streamable HTTP requires the client to accept both content types.
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args }
    })
  })
}

/** Build an MCP 2026-07-28 request with its required per-request envelope. */
export function modernMcpRequest(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  options: {
    id?: number | string
    url?: string
    origin?: string
    host?: string
    headers?: Record<string, string>
  } = {}
): Request {
  const name = typeof params.name === 'string' ? params.name : undefined
  return new Request(options.url ?? MCP_URL, {
    method: 'POST',
    headers: {
      Host: options.host ?? MCP_HOST,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MODERN_MCP_VERSION,
      'Mcp-Method': method,
      ...(name && { 'Mcp-Name': name }),
      ...(options.origin && { Origin: options.origin }),
      ...options.headers
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: options.id ?? 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': MODERN_MCP_VERSION,
          'io.modelcontextprotocol/clientInfo': {
            name: 'cloudflare-mcp-tests',
            version: '1.0.0'
          },
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    })
  })
}

/** Parse a Streamable HTTP response, which may be JSON or an SSE `data:` frame. */
export async function parseMcpResult(res: Response): Promise<McpToolResult> {
  const text = await res.text()
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    const dataLine = text.split('\n').find((line) => line.startsWith('data:'))
    return JSON.parse(dataLine!.slice('data:'.length).trim())
  }
  return JSON.parse(text)
}

/** Drive the real worker: call `name` with `args` and return the parsed result. */
export async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> | null,
  options?: { method: 'tools/list' | 'tools/call' }
): Promise<McpToolResult> {
  const req =
    options?.method === 'tools/list'
      ? mcpToolListRequest(token)
      : mcpToolCallRequest(token, name, args ?? {})
  const res = await exports.default.fetch(req)
  return parseMcpResult(res)
}

/** Convenience: the text payload of the first content block. */
export function toolText(result: McpToolResult): string {
  return result.result?.content?.[0]?.text ?? ''
}

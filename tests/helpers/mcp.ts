import { exports } from 'cloudflare:workers'

/** Result envelope of an MCP `tools/call` over Streamable HTTP. */
export interface McpToolResult {
  result?: {
    content?: Array<{ type: string; text: string }>
    isError?: boolean
    tools?: Array<{ name: string; title?: string; annotations?: { title?: string; readOnlyHint?: boolean } }>
  }
  error?: { code: number; message: string }
}

/** Build a JSON-RPC `tools/list` request to the worker's `/mcp` endpoint. */
export function mcpToolListRequest(token: string, id = 1): Request {
  return new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })
  })
}

/** Build a JSON-RPC `tools/call` request to the worker's `/mcp` endpoint. */
export function mcpToolCallRequest(
  token: string,
  name: string,
  args: Record<string, unknown>,
  id = 1
): Request {
  return new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: {
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

/** Parse a Streamable HTTP response, which may be JSON or an SSE `data:` frame. */
export async function parseMcpResult(res: Response): Promise<McpToolResult> {
  const text = await res.text()
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'))
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

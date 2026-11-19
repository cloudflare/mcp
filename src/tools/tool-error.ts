import type { CallToolResult } from '@modelcontextprotocol/server'

export function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

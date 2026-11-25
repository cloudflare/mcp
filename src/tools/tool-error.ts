import type { CallToolResult } from '@modelcontextprotocol/server'
import { classified } from '../tool-errors'
import type { ToolErrorKind } from '../tool-errors'

/**
 * A tool error result with `message`, tagged with why it failed for metrics,
 * and the status of the Cloudflare answer that failed it, if one did.
 */
export function toolError(message: string, kind: ToolErrorKind, status?: number): CallToolResult {
  return classified({ content: [{ type: 'text', text: message }], isError: true }, kind, status)
}

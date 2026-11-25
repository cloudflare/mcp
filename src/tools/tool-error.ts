import type { CallToolResult } from '@modelcontextprotocol/server'
import { classified } from '../tool-errors'
import type { ToolErrorKind } from '../tool-errors'

/** A tool error result with `message`, tagged with why it failed for metrics. */
export function toolError(message: string, kind: ToolErrorKind): CallToolResult {
  return classified({ content: [{ type: 'text', text: message }], isError: true }, kind)
}

/**
 * Build the standard MCP error result for a tool callback.
 *
 * Accepts either a thrown value (whose message is extracted) or a plain message
 * string, and returns the `{ content, isError }` shape every tool uses to
 * signal failure — e.g. `return formatError(error)` or
 * `return formatError('missing required path parameter: account_id')`.
 */
export function formatError(error: unknown): {
  content: Array<{ type: 'text'; text: string }>
  isError: true
} {
  const message = error instanceof Error ? error.message : String(error)
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true
  }
}

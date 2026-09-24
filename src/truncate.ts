const CHARS_PER_TOKEN = 4
const MAX_TOKENS = 6000
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN

/** Renders a tool's result value as the text content sent to the MCP client. */
export type FormatToolResult = (content: unknown) => string

/**
 * Render a tool result as text with no size cap. Strings pass through; other
 * values become pretty-printed JSON. A value JSON cannot represent, such as
 * `undefined` from code that returns nothing, becomes its `String()` form.
 */
export function stringifyResponse(content: unknown): string {
  if (typeof content === 'string') return content
  return JSON.stringify(content, null, 2) ?? String(content)
}

/**
 * Render a tool result as text capped at ~6,000 tokens. Oversized text is cut
 * and followed by a notice with the original size, so the agent knows to
 * narrow its request.
 */
export function truncateResponse(content: unknown): string {
  const text = stringifyResponse(content)

  if (text.length <= MAX_CHARS) {
    return text
  }

  const truncated = text.slice(0, MAX_CHARS)
  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN)

  return `${truncated}\n\n--- TRUNCATED ---\nResponse was ~${estimatedTokens.toLocaleString()} tokens (limit: ${MAX_TOKENS.toLocaleString()}). Use more specific queries to reduce response size.`
}

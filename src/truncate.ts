const CHARS_PER_TOKEN = 4
const MAX_TOKENS = 6000
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN

export function truncateResponse(content: unknown): string {
  const text = stringifyResponse(content)

  if (text.length <= MAX_CHARS) {
    return text
  }

  const truncated = text.slice(0, MAX_CHARS)
  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN)

  return `${truncated}\n\n--- TRUNCATED ---\nResponse was ~${estimatedTokens.toLocaleString()} tokens (limit: ${MAX_TOKENS.toLocaleString()}). Use more specific queries to reduce response size.`
}

/**
 * JSON.stringify is not defined for undefined, BigInt, or cyclic objects.
 * Sandbox results that still crossed the Worker RPC boundary must produce a
 * usable MCP text payload instead of throwing inside the response formatter.
 */
function stringifyResponse(content: unknown): string {
  if (typeof content === 'string') return content
  if (typeof content === 'undefined') return 'undefined'
  if (typeof content === 'bigint') return `${content.toString()}n`

  const seen = new WeakSet<object>()
  try {
    const json = JSON.stringify(
      content,
      (_key, value: unknown) => {
        if (typeof value === 'bigint') return `${value.toString()}n`
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]'
          seen.add(value)
        }
        return value
      },
      2
    )
    return json ?? 'undefined'
  } catch {
    return String(content)
  }
}

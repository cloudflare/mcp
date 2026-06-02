/**
 * Structured diagnostic logging primitive.
 *
 * The companion to {@link createTelemetry}. Telemetry is for countable domain
 * events; this is for leveled diagnostics (a recoverable KV miss, an upstream
 * error, an unexpected exception). Both emit the same greppable
 * `[<channel>] {json}` shape so a single log pipeline can parse everything.
 *
 * Rules of thumb:
 *  - Reach for a **telemetry channel** when you want to *count* something
 *    (refresh outcomes, cache hits) — stable `kind` field, no free text.
 *  - Reach for a **logger** when you want to *describe* something that went
 *    wrong, with a human message and structured context.
 *
 * `Error` values in `fields` are serialized to `{ name, message, stack }`
 * (plain `JSON.stringify` would drop them to `{}`).
 *
 * @example
 * const log = createLogger('oauth-handler')
 * log.warn('failed to read cached refresh failure', { error })
 * // [oauth-handler] {"level":"warn","message":"failed to read cached refresh failure","error":{...},"at":...}
 */
export type LogLevel = 'info' | 'warn' | 'error'

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

function serializeErrors(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  return value
}

export function createLogger(channel: string): Logger {
  const emit = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    const line = JSON.stringify({ level, message, ...fields, at: Date.now() }, serializeErrors)
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    sink(`[${channel}] ${line}`)
  }

  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields)
  }
}

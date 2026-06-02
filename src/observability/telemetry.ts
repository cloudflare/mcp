/**
 * Structured telemetry primitive.
 *
 * Emits one JSON line per event, prefixed with `[<channel>]`, so events are
 * greppable and countable in Workers Logs (and any log sink) without a metrics
 * backend. A timestamp (`at`, epoch ms) is attached automatically.
 *
 * This is the canonical pattern for structured diagnostics in this worker:
 * declare a typed event shape, create a channel once, and call it. Prefer this
 * over ad-hoc `console.log(JSON.stringify(...))` so every subsystem emits a
 * consistent, parseable format.
 *
 * @example
 * interface RefreshEvent { kind: 'upstream_terminal' | 'cached_replay'; code: string }
 * const refreshTelemetry = createTelemetry<RefreshEvent>('refresh-telemetry')
 * refreshTelemetry({ kind: 'upstream_terminal', code: 'invalid_grant' })
 * // logs: [refresh-telemetry] {"kind":"upstream_terminal","code":"invalid_grant","at":1780000000000}
 */
export type TelemetryEmitter<E extends object> = (event: E) => void

export function createTelemetry<E extends object>(channel: string): TelemetryEmitter<E> {
  return (event: E) => {
    console.log(`[${channel}] ${JSON.stringify({ ...event, at: Date.now() })}`)
  }
}

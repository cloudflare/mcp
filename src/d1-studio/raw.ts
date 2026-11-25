/**
 * D1's `/raw` body as an outcome, for the tool and for the view's re-runs
 * (which read the same body through the generated `d1_raw` tool). Pure: no
 * Worker or DOM imports.
 */
import { z } from 'zod'
import { MAX_ROWS, type D1Cell, type D1Outcome } from './contract'
import { cleanD1Error, errorToken } from './statement'

const RawStatement = z.object({
  results: z
    .object({
      columns: z.array(z.string()).optional(),
      rows: z.array(z.array(z.unknown())).optional()
    })
    .optional(),
  meta: z
    .object({
      duration: z.number().optional(),
      rows_read: z.number().optional(),
      rows_written: z.number().optional(),
      timings: z.object({ sql_duration_ms: z.number().optional() }).optional()
    })
    .optional()
})
const RawBody = z.object({
  success: z.boolean().optional(),
  errors: z.array(z.object({ code: z.number().optional(), message: z.string() })).nullish(),
  // A failed query's envelope has `result: null`.
  result: z.array(RawStatement).nullish()
})

const cell = (v: unknown): D1Cell =>
  v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    ? v
    : JSON.stringify(v)

/**
 * What a raw query's body says. The last statement's result is the one shown,
 * as in the dashboard. Rows past {@link MAX_ROWS} are dropped and counted.
 */
export function rawOutcome(status: number, body: unknown): D1Outcome {
  const parsed = RawBody.safeParse(body)
  if (!parsed.success) return { status: 'failed', error: 'D1 returned an unexpected response.' }
  const errors = parsed.data.errors ?? []
  const { result } = parsed.data
  const last = result?.at(-1)
  if (status >= 400 || parsed.data.success === false || !last) {
    const error = cleanD1Error(errors.map((e) => e.message).join('; ') || `HTTP ${status}`)
    const token = errorToken(error)
    return { status: 'failed', error, ...(token && { token }) }
  }
  const rows = last.results?.rows ?? []
  return {
    status: 'rows',
    columns: last.results?.columns ?? [],
    rows: rows.slice(0, MAX_ROWS).map((row) => row.map(cell)),
    rowCount: rows.length,
    meta: {
      durationMs: last.meta?.timings?.sql_duration_ms ?? last.meta?.duration ?? null,
      rowsRead: last.meta?.rows_read ?? null,
      rowsWritten: last.meta?.rows_written ?? null
    }
  }
}

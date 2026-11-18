/**
 * Calendar arithmetic for the alert's two periods, in UTC. Pure, so the view
 * and the collector agree and tests need no clock.
 */

export interface Period {
  /** `YYYY-MM`. */
  readonly month: string
  /** First day, `YYYY-MM-DD`. */
  readonly start: string
  /** Last day read, `YYYY-MM-DD`: the month's last day, or `asOf` for the current month. */
  readonly end: string
  /** Days in the whole month. */
  readonly days: number
}

const iso = (date: Date) => date.toISOString().slice(0, 10)

function monthOf(year: number, month: number, endDay?: number): Period {
  const first = new Date(Date.UTC(year, month, 1))
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return {
    month: iso(first).slice(0, 7),
    start: iso(first),
    end: iso(new Date(Date.UTC(year, month, endDay ?? days))),
    days
  }
}

/**
 * The current month up to `asOf`, and the whole month before it.
 *
 * Each fits the GraphQL Analytics API's widest `workersInvocationsAdaptive`
 * range (measured at 4w4d, about 32 days), so each is one query.
 *
 * @param asOf - `YYYY-MM-DD`, treated as today.
 */
export function periodsAsOf(asOf: string): { current: Period; previous: Period } {
  const [year, month, day] = asOf.split('-').map(Number)
  return {
    current: monthOf(year, month - 1, day),
    previous: monthOf(year, month - 2)
  }
}

/** Round to a readable threshold: 250 million steps above a billion, 25 million below. */
export function roundLimit(requests: number): number {
  const step = requests >= 1e9 ? 2.5e8 : 2.5e7
  return Math.max(step, Math.round(requests / step) * step)
}

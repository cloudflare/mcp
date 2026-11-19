/**
 * The alert's arithmetic, shared by the collector and the view so the model's
 * text and the chart agree. Pure: no clock, no DOM.
 *
 * The alert is a monitor that every hour counts the last 7 days of Workers
 * requests and emails when the count passes a line. So the unit is requests
 * per 7 days, and every number here is in that unit.
 */

/** One complete UTC day: `[YYYY-MM-DD, requests]`. */
export type Day = [string, number]

const DAY_MS = 864e5
const PERIOD = 7

export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`)
const dayNumber = (date: string) => Math.round(dayMs(date) / DAY_MS)

// ── Scale: nice numbers, 1, 2, 5 × 10ⁿ, so steps and ticks suit any account size ──

export function nice(x: number, set: readonly number[] = [1, 2, 5]): number {
  const e = 10 ** Math.floor(Math.log10(x))
  return (set.find((m) => m * e >= x * 0.9999) ?? 10) * e
}
/** Drag and arrow-key precision: about 30 stops per axis. */
export const stepOf = (top: number) => Math.max(1, nice(top / 30))
/** Gridline spacing: 2 to 5 lines. */
export const tickOf = (top: number) => Math.max(1, nice(top / 5, [1, 2, 2.5, 5]))
/** The axis top for a value: the next half tick above it. */
export function niceTop(value: number): number {
  const v = Math.max(value, 10)
  const half = tickOf(v) / 2
  return Math.ceil(v / half - 1e-9) * half
}
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
export const snapTo = (v: number, step: number) => Math.round(v / step) * step

// ── The monitor ──

/** The 7-day total at the end of each day from the seventh on: what the monitor's query returns then. */
export function rolling7(days: readonly Day[]): Map<string, number> {
  const out = new Map<string, number>()
  let total = 0
  days.forEach(([date, n], i) => {
    total += n
    if (i >= PERIOD) total -= days[i - PERIOD][1]
    if (i >= PERIOD - 1) out.set(date, total)
  })
  return out
}

/**
 * The median day × 7. An account idle most days falls back to the mean, so
 * only true silence, or under a week of history, has no typical week.
 */
export function typicalWeek(days: readonly Day[]): number | null {
  if (days.length < PERIOD) return null
  const sorted = days.map(([, n]) => n).sort((a, b) => a - b)
  const median = sorted[sorted.length >> 1]
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length
  return (median || mean) * PERIOD || null
}

export interface Email {
  readonly date: string
  /** The first email of a run over the line, rather than a 7-day repeat. */
  readonly first: boolean
}

/** Replay the monitor: an email when the 7-day count first passes `limit`, then every 7 days while it stays over. */
export function replayEmails(
  days: readonly Day[],
  roll: ReadonlyMap<string, number>,
  limit: number
): Email[] {
  const out: Email[] = []
  let last: string | null = null
  for (const [date] of days) {
    const total = roll.get(date)
    if (total == null) continue
    if (total < limit) {
      last = null
      continue
    }
    if (last == null || dayNumber(date) - dayNumber(last) >= PERIOD) {
      out.push({ date, first: last == null })
      last = date
    }
  }
  return out
}

// ── The chart's model ──

export interface Week {
  readonly start: string
  readonly end: string
  /** The week's last day with data. */
  readonly lastDay: string | null
  /** Measured requests, and the estimate for this week's remaining days. */
  readonly rawActual: number
  readonly rawEstimate: number
  /** Day offset from the first week's start, for placing the column. */
  readonly offset: number
  readonly daysActual: number
  readonly daysEstimate: number
  /** Heights on the 7-day scale: the week's average day × 7. */
  readonly actual: number
  readonly estimate: number
  readonly total: number
  /** The 7-day total at `lastDay`. */
  readonly rolling: number | null
  /** A week the read window cuts, drawn as an outline. */
  readonly partial: boolean
}

export interface Month {
  /** `YYYY-MM`. */
  readonly key: string
  /** Day offsets the month covers on the chart. */
  readonly from: number
  readonly to: number
}

export interface Model {
  readonly days: readonly Day[]
  readonly weeks: readonly Week[]
  readonly months: readonly Month[]
  /** Days the chart spans, from the first week's start. */
  readonly span: number
  readonly rolling: ReadonlyMap<string, number>
  readonly typical: number | null
  /** The last 7 complete days. */
  readonly last7: number
  /** The busiest 7 days in the history. */
  readonly peak: number
  /** The highest normal week: one far above the rest runs off the top instead of flattening the others. */
  readonly dataTop: number
  /** The fitted axis top, and the range the line can reach. */
  readonly base: number
  readonly minTop: number
  readonly minLimit: number
  readonly maxLimit: number
  /** "Clearly bigger than normal": a typical week plus a quarter, on the axis's step. */
  readonly suggested: number | null
}

/** Headroom above whichever is higher, the normal weeks or the line. */
export const fitTop = (model: Model, limit: number) =>
  niceTop(Math.max(model.dataTop, limit) * 1.15)

/**
 * Derive everything the card shows from the complete days.
 *
 * @param days - Complete UTC days, oldest first, with no gaps.
 * @param today - The first day not in `days`; this week's rest is estimated from the last 7 days' pace.
 */
export function deriveModel(days: readonly Day[], today: string): Model {
  const rolling = rolling7(days)
  const pace = days.length
    ? days.slice(-PERIOD).reduce((a, [, n]) => a + n, 0) / Math.min(PERIOD, days.length)
    : 0
  const values = new Map(days)
  const weeks: Week[] = []
  if (days.length) {
    const first = dayMs(days[0][0])
    const mondayOf = (ms: number) => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS
    const origin = mondayOf(first)
    const end = mondayOf(dayMs(today)) + 6 * DAY_MS
    const lastActual = days[days.length - 1][0]
    for (let w = origin; w <= end; w += PERIOD * DAY_MS) {
      let actual = 0
      let nActual = 0
      let estimate = 0
      let nEstimate = 0
      let lastDay: string | null = null
      for (let i = 0; i < PERIOD; i++) {
        const date = isoDay(w + i * DAY_MS)
        const n = values.get(date)
        if (n != null) {
          actual += n
          nActual++
          lastDay = date
        } else if (date > lastActual) {
          estimate += pace
          nEstimate++
        }
      }
      const n = nActual + nEstimate
      if (!n) continue
      weeks.push({
        start: isoDay(w),
        end: isoDay(w + 6 * DAY_MS),
        lastDay,
        rawActual: actual,
        rawEstimate: estimate,
        offset: Math.round((w - origin) / DAY_MS),
        daysActual: nActual,
        daysEstimate: nEstimate,
        actual: (actual / n) * PERIOD,
        estimate: (estimate / n) * PERIOD,
        total: ((actual + estimate) / n) * PERIOD,
        rolling: lastDay ? (rolling.get(lastDay) ?? null) : null,
        partial: n < PERIOD && !nEstimate
      })
    }
  }
  // The window opens mid-week: start the chart at the first day with data.
  const shift = weeks[0]?.offset ?? 0
  const placed = weeks.map((w) => ({ ...w, offset: w.offset - shift }))
  const span = placed.length ? placed[placed.length - 1].offset + PERIOD : 1
  const origin = placed.length ? dayMs(placed[0].start) : 0
  const offsetOf = (date: string) => Math.round((dayMs(date) - origin) / DAY_MS)

  const months: Month[] = []
  for (const [date] of days) {
    const key = date.slice(0, 7)
    const at = Math.max(0, offsetOf(date))
    const last = months[months.length - 1]
    if (last?.key === key) months[months.length - 1] = { ...last, to: at + 1 }
    else months.push({ key, from: at, to: at + 1 })
  }

  const typical = typicalWeek(days)
  const last7 = days.length ? (rolling.get(days[days.length - 1][0]) ?? pace * PERIOD) : 0
  const peak = Math.max(0, ...rolling.values())
  const totals = placed.map((w) => w.total).sort((a, b) => b - a)
  const dataTop = Math.max(
    last7,
    totals.length > 3 && totals[0] > 1.6 * totals[1] ? totals[1] : (totals[0] ?? 0)
  )
  const base = niceTop(dataTop * 1.15)
  const minTop = Math.max(10, niceTop(base / 100))
  const minLimit = stepOf(minTop)
  const maxLimit = niceTop(Math.max(dataTop, 10) * 100)
  const suggested =
    typical == null ? null : clamp(snapTo(typical * 1.25, stepOf(base)), minLimit, maxLimit)
  return {
    days,
    weeks: placed,
    months,
    span,
    rolling,
    typical,
    last7,
    peak,
    dataTop,
    base,
    minTop,
    minLimit,
    maxLimit,
    suggested
  }
}

/** The SQL the monitor runs every hour. Its daily counts match the GraphQL read. */
export function monitorQuery(accountId: string): string {
  return `SELECT COUNT(*) AS value
FROM events.workersInvocations
WHERE accountTag = '${accountId}'
  AND timestamp >= NOW() - INTERVAL '7' DAY`
}

/** The `custom_analytics` policy the App proposes. Nothing sends it; see `docs/workers-usage-alert.md`. */
export function monitorPolicy(accountId: string, limit: number, email: string, name: string) {
  return {
    name,
    alert_type: 'custom_analytics',
    enabled: true,
    filters: {
      source: ['sql_api'],
      selectors: [monitorQuery(accountId)],
      alert_trigger_preferences: ['threshold'],
      alert_trigger_preferences_operator: ['>='],
      alert_trigger_preferences_value: [String(limit)],
      alert_trigger_preferences_short_window: ['168h'],
      execution_interval: ['1h']
    },
    alert_interval: '168h',
    mechanisms: { email: [{ id: email }] }
  }
}

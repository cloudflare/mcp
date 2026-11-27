/**
 * A threshold alert's arithmetic: a daily history of one number, the rule the
 * alert applies to it, and the chart that shows both. Shared by every
 * preset's collector and the view, so the model's text and the chart agree.
 * Pure: no clock, no DOM.
 *
 * A preset picks a {@link Cadence}: what the alert compares with its line
 * each day, and the buckets the chart draws. Every number here is in the
 * cadence's unit (requests in 7 days, requests in a month).
 */

/** One complete UTC day: `[YYYY-MM-DD, value]`. */
export type Day = [string, number]

const DAY_MS = 864e5
/** Days of history before there is a typical period to compare against. */
const MIN_DAYS = 7
/** An average month, for the typical month. */
const MONTH_DAYS = 365.25 / 12

export const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`)
const dayNumber = (date: string) => Math.round(dayMs(date) / DAY_MS)

/**
 * What the alert measures, and how the chart groups days.
 *
 * - `rolling`: every day it compares the last `days` days with the line, and
 *   emails again every `days` days while over (a `custom_analytics` monitor
 *   with a `168h` window and `alert_interval`). The chart draws weeks.
 * - `month`: it compares the total since the month began, emails once when
 *   that passes the line, and starts again next month (billing alerts). The
 *   chart draws calendar months.
 */
export type Cadence = { readonly kind: 'rolling'; readonly days: 7 } | { readonly kind: 'month' }

export const ROLLING_7_DAYS: Cadence = { kind: 'rolling', days: 7 }
export const CALENDAR_MONTH: Cadence = { kind: 'month' }

/** Days in a typical period: what a typical week is scaled to. */
const typicalDays = (cadence: Cadence) => (cadence.kind === 'rolling' ? cadence.days : MONTH_DAYS)

// ── Scale: nice numbers, 1, 2, 5 × 10ⁿ, so steps and ticks suit any account size ──

export function nice(x: number, set: ReadonlyArray<number> = [1, 2, 5]): number {
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

// ── The alert's rule ──

/** The 7-day total at the end of each day from the seventh on: what the monitor's query returns then. */
export function rolling7(days: ReadonlyArray<Day>): Map<string, number> {
  return measured(days, ROLLING_7_DAYS)
}

/**
 * What the alert compares with its line at the end of each day: the last
 * `days` days from the first full window on (`rolling`), or the total since
 * the month began (`month`).
 */
export function measured(days: ReadonlyArray<Day>, cadence: Cadence): Map<string, number> {
  const out = new Map<string, number>()
  let total = 0
  if (cadence.kind === 'month') {
    let month = ''
    for (const [date, n] of days) {
      if (date.slice(0, 7) !== month) {
        month = date.slice(0, 7)
        total = 0
      }
      total += n
      out.set(date, total)
    }
    return out
  }
  const period = cadence.days
  days.forEach(([date, n], i) => {
    total += n
    if (i >= period) {
      total -= days[i - period][1]
    }
    if (i >= period - 1) {
      out.set(date, total)
    }
  })
  return out
}

/**
 * The median 7-day total, scaled to the period's days. Every 7-day window
 * holds one of each weekday, so quiet weekends count as they do in a real
 * week or month; a median day × the period's days would count every day as a
 * weekday and run 10–15% high on a weekday-heavy account. An account idle
 * most weeks falls back to the mean, so only true silence, or under a week of
 * history, has no typical period.
 */
export function typicalPeriod(days: ReadonlyArray<Day>, cadence: Cadence = ROLLING_7_DAYS) {
  if (days.length < MIN_DAYS) {
    return null
  }
  const weeks = [...measured(days, ROLLING_7_DAYS).values()].sort((a, b) => a - b)
  const median = weeks[weeks.length >> 1]
  const mean = days.reduce((a, [, n]) => a + n, 0) / days.length
  const scale = typicalDays(cadence) / 7
  return (median ? median * scale : mean * typicalDays(cadence)) || null
}

/** The median 7-day total. */
export const typicalWeek = (days: ReadonlyArray<Day>) => typicalPeriod(days, ROLLING_7_DAYS)

export interface Email {
  readonly date: string
  /** The first email of a run over the line, rather than a repeat while it stays over. */
  readonly first: boolean
}

/**
 * Replay the alert over the history. `rolling`: an email when the window
 * first passes `limit`, then every `days` days while it stays over. `month`:
 * one email the day the month's total passes `limit`.
 */
export function replayEmails(
  days: ReadonlyArray<Day>,
  values: ReadonlyMap<string, number>,
  limit: number,
  cadence: Cadence = ROLLING_7_DAYS
): Array<Email> {
  const out: Array<Email> = []
  if (cadence.kind === 'month') {
    let sent = ''
    for (const [date] of days) {
      const total = values.get(date)
      const month = date.slice(0, 7)
      if (total === undefined || total < limit || sent === month) {
        continue
      }
      out.push({ date, first: true })
      sent = month
    }
    return out
  }
  let last: string | null = null
  for (const [date] of days) {
    const total = values.get(date)
    if (total === undefined) {
      continue
    }
    if (total < limit) {
      last = null
      continue
    }
    if (last === null || dayNumber(date) - dayNumber(last) >= cadence.days) {
      out.push({ date, first: last === null })
      last = date
    }
  }
  return out
}

// ── The chart's model ──

/** One column: a Monday-to-Sunday week, or a calendar month. */
export interface Bucket {
  readonly start: string
  readonly end: string
  /** Days the bucket spans: 7, or the month's. */
  readonly length: number
  /** The bucket's last day with data. */
  readonly lastDay: string | null
  /** Measured values, and the estimate for the bucket's remaining days. */
  readonly rawActual: number
  readonly rawEstimate: number
  /** Day offset from the first bucket's start, for placing the column. */
  readonly offset: number
  readonly daysActual: number
  readonly daysEstimate: number
  /** Heights on the alert's scale: the bucket's average day × its length. */
  readonly actual: number
  readonly estimate: number
  readonly total: number
  /** What the alert measured at `lastDay`. */
  readonly rolling: number | null
  /** A bucket the read window cuts, drawn as an outline. */
  readonly partial: boolean
}
/** The weekly cadence's bucket. */
export type Week = Bucket

export interface Month {
  /** `YYYY-MM`. */
  readonly key: string
  /** Day offsets the month covers on the chart. */
  readonly from: number
  readonly to: number
}

export interface Model {
  readonly cadence: Cadence
  readonly days: ReadonlyArray<Day>
  readonly weeks: ReadonlyArray<Bucket>
  readonly months: ReadonlyArray<Month>
  /** Days the chart spans, from the first bucket's start. */
  readonly span: number
  /** What the alert measured at the end of each day. */
  readonly rolling: ReadonlyMap<string, number>
  readonly typical: number | null
  /** What the alert measures now: the last 7 complete days, or this month so far. */
  readonly current: number
  /** The busiest period in the history. */
  readonly peak: number
  /** The highest normal bucket: one far above the rest runs off the top instead of flattening the others. */
  readonly dataTop: number
  /** The fitted axis top, and the range the line can reach. */
  readonly base: number
  readonly minTop: number
  readonly minLimit: number
  readonly maxLimit: number
  /**
   * "Clearly bigger than normal": a tenth above the busiest period in the
   * history or the tallest bar, whichever is higher, rounded up on the axis's step. Nothing in the history would
   * have emailed, and the chart scales up to show the line above every bucket.
   */
  readonly suggested: number | null
}

/** The suggested threshold over the busiest period. */
export const SUGGESTED_OVER_BUSIEST = 1.1

/** Headroom above whichever is higher, the normal buckets or the line. */
export const fitTop = (model: Model, limit: number) =>
  niceTop(Math.max(model.dataTop, limit) * 1.15)

const mondayOf = (ms: number) => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS
const monthOf = (ms: number) => {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}
const nextMonth = (ms: number) => {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

/** `[start, length]` of each bucket from the one holding `first` to the one holding `today`. */
function buckets(cadence: Cadence, first: number, today: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  if (cadence.kind === 'rolling') {
    for (let w = mondayOf(first); w <= today; w += 7 * DAY_MS) {
      out.push([w, 7])
    }
  } else {
    for (let m = monthOf(first); m <= today; m = nextMonth(m)) {
      out.push([m, Math.round((nextMonth(m) - m) / DAY_MS)])
    }
  }
  return out
}

/**
 * Derive everything the card shows from the complete days.
 *
 * @param days - Complete UTC days, oldest first, with no gaps.
 * @param today - The first day not in `days`; the current bucket's rest is estimated from the last 7 days' pace.
 * @param cadence - The alert's rule. Defaults to the rolling 7 days the Workers monitor uses.
 */
export function deriveModel(
  days: ReadonlyArray<Day>,
  today: string,
  cadence: Cadence = ROLLING_7_DAYS
): Model {
  const rolling = measured(days, cadence)
  const pace = days.length
    ? days.slice(-MIN_DAYS).reduce((a, [, n]) => a + n, 0) / Math.min(MIN_DAYS, days.length)
    : 0
  const values = new Map(days)
  const weeks: Array<Bucket> = []
  const lastDay = days.at(-1)
  if (lastDay) {
    const lastActual = lastDay[0]
    const all = buckets(cadence, dayMs(days[0][0]), dayMs(today))
    const origin = all[0]?.[0] ?? 0
    for (const [w, length] of all) {
      let actual = 0
      let nActual = 0
      let estimate = 0
      let nEstimate = 0
      let lastDay: string | null = null
      for (let i = 0; i < length; i++) {
        const date = isoDay(w + i * DAY_MS)
        const n = values.get(date)
        if (n !== undefined) {
          actual += n
          nActual++
          lastDay = date
        } else if (date > lastActual) {
          estimate += pace
          nEstimate++
        }
      }
      const n = nActual + nEstimate
      if (!n) {
        continue
      }
      weeks.push({
        start: isoDay(w),
        end: isoDay(w + (length - 1) * DAY_MS),
        length,
        lastDay,
        rawActual: actual,
        rawEstimate: estimate,
        offset: Math.round((w - origin) / DAY_MS),
        daysActual: nActual,
        daysEstimate: nEstimate,
        actual: (actual / n) * length,
        estimate: (estimate / n) * length,
        total: ((actual + estimate) / n) * length,
        rolling: lastDay ? (rolling.get(lastDay) ?? null) : null,
        partial: n < length && !nEstimate
      })
    }
  }
  // The window opens mid-bucket: start the chart at the first day with data.
  const shift = weeks[0]?.offset ?? 0
  const placed = weeks.map((w) => ({ ...w, offset: w.offset - shift }))
  const lastBucket = placed.at(-1)
  const span = lastBucket ? lastBucket.offset + lastBucket.length : 1
  const origin = placed.length ? dayMs(placed[0].start) : 0
  const offsetOf = (date: string) => Math.round((dayMs(date) - origin) / DAY_MS)

  const months: Array<Month> = []
  for (const [date] of days) {
    const key = date.slice(0, 7)
    const at = Math.max(0, offsetOf(date))
    const last = months.at(-1)
    if (last?.key === key) {
      months[months.length - 1] = { ...last, to: at + 1 }
    } else {
      months.push({ key, from: at, to: at + 1 })
    }
  }

  const lastDate = lastDay?.[0]
  const current = !lastDate
    ? 0
    : cadence.kind === 'rolling'
      ? (rolling.get(lastDate) ?? pace * cadence.days)
      : // Yesterday's month total, or 0 when today starts a new month.
        lastDate.slice(0, 7) === today.slice(0, 7)
        ? (rolling.get(lastDate) ?? 0)
        : 0
  // The busiest period: the most the alert measured on any day, and, by month, this month
  // projected to its end. A month the window cuts counts as far as it was read, a lower bound.
  const projected =
    cadence.kind === 'month' ? placed.flatMap((w) => (w.partial ? [] : [w.total])) : []
  const peak = Math.max(0, ...rolling.values(), ...projected)
  // A typical month is never above the busiest one charted: on a growing account the median
  // week, scaled to a month, can pass every whole month read.
  const typicalRaw = typicalPeriod(days, cadence)
  const typical =
    typicalRaw !== null && cadence.kind === 'month' && peak > 0
      ? Math.min(typicalRaw, peak)
      : typicalRaw
  const totals = placed.map((w) => w.total).sort((a, b) => b - a)
  const dataTop = Math.max(
    current,
    totals.length > 3 && totals[0] > 1.6 * totals[1] ? totals[1] : (totals[0] ?? 0)
  )
  const base = niceTop(dataTop * 1.15)
  const minTop = Math.max(10, niceTop(base / 100))
  const minLimit = stepOf(minTop)
  const maxLimit = niceTop(Math.max(dataTop * 100, peak * 10, 10))
  // A tenth over the tallest thing on the chart: the busiest period, or a bar drawn taller than it
  // (this period's estimate, a cut bucket scaled to its length), so the line opens above every bar.
  const over = Math.max(peak, ...placed.map((w) => w.total)) * SUGGESTED_OVER_BUSIEST
  const step = stepOf(niceTop(over))
  const suggested =
    typical === null ? null : clamp(Math.ceil(over / step) * step, minLimit, maxLimit)
  return {
    cadence,
    days,
    weeks: placed,
    months,
    span,
    rolling,
    typical,
    current,
    peak,
    dataTop,
    base,
    minTop,
    minLimit,
    maxLimit,
    suggested
  }
}

import type { UsageAlertPreview } from '../contract'

/** Cumulative points `[dayOfMonth, total]` for daily rows. */
export function cumulative(rows: UsageAlertPreview['current']): [number, number][] {
  let total = 0
  return rows.map(([date, requests]) => [Number(date.slice(8, 10)), (total += requests)])
}

/** The first day a cumulative series reaches `limit`, if it does. */
export function crossingDay(
  series: readonly [number, number][],
  limit: number
): number | undefined {
  return series.find(([, total]) => total >= limit)?.[0]
}

/**
 * The current month projected to its end from the last seven days' average.
 * Starts at the last observed point so the dashed line joins the solid one.
 */
export function projection(
  current: readonly [number, number][],
  daily: UsageAlertPreview['current'],
  daysInMonth: number
): [number, number][] {
  const last = current.at(-1)
  if (!last) return []
  const recent = daily.slice(-7)
  const average =
    recent.reduce((sum, [, requests]) => sum + requests, 0) / Math.max(1, recent.length)
  const points: [number, number][] = [last]
  for (let day = last[0] + 1; day <= daysInMonth; day++)
    points.push([day, points[points.length - 1][1] + average])
  return points
}

/** `2.4B`, `830M`, `12K`. */
export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`
  return String(Math.round(n))
}

/** `2026-10` → `Oct`. */
export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString('en', { month: 'short', timeZone: 'UTC' })
}

export function daysIn(month: string): number {
  const [year, m] = month.split('-').map(Number)
  return new Date(Date.UTC(year, m, 0)).getUTCDate()
}

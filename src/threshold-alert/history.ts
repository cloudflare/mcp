/**
 * The days a threshold alert's collector reads, in UTC. Pure, so tests need no clock and the
 * view can import it. The read itself is `read.ts`.
 */
import { isoDay, dayMs, type Day } from './model'

/** Days of history read: the Workers analytics retention (12w6d), less today. R2 storage reads the same days. */
export const HISTORY_DAYS = 89

const DAY_MS = 864e5
/** The widest range one `workersInvocationsAdaptive` alias accepts is 4w4d (measured), and R2 datasets 31 days; 30 days stays inside both. */
const ALIAS_DAYS = 30

export interface Window {
  /** `YYYY-MM-DD`, inclusive. */
  readonly start: string
  readonly end: string
}

/**
 * The complete days before `today` that analytics still hold, oldest first,
 * split into ranges one GraphQL alias can read.
 */
export function historyWindows(today: string): Window[] {
  const end = dayMs(today) - DAY_MS
  const windows: Window[] = []
  for (let s = end - (HISTORY_DAYS - 1) * DAY_MS; s <= end; s += ALIAS_DAYS * DAY_MS)
    windows.push({ start: isoDay(s), end: isoDay(Math.min(s + (ALIAS_DAYS - 1) * DAY_MS, end)) })
  return windows
}

/**
 * Every day from the first with traffic to the last window's end, with the
 * days GraphQL leaves out (no invocations) as 0.
 */
export function fillDays(rows: Iterable<Day>, windows: readonly Window[]): Day[] {
  const counts = new Map<string, number>()
  for (const [date, n] of rows) counts.set(date, (counts.get(date) ?? 0) + n)
  const traffic = [...counts]
    .filter(([, n]) => n > 0)
    .map(([d]) => d)
    .sort()
  if (!traffic.length || !windows.length) return []
  const out: Day[] = []
  const last = dayMs(windows[windows.length - 1].end)
  for (let t = dayMs(traffic[0]); t <= last; t += DAY_MS) {
    const date = isoDay(t)
    out.push([date, counts.get(date) ?? 0])
  }
  return out
}

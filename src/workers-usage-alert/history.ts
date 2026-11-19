/**
 * The days the collector reads, in UTC. Pure, so tests need no clock.
 */
import { HISTORY_DAYS } from './contract'
import { isoDay, dayMs, type Day } from './model'

const DAY_MS = 864e5
/** The widest range one `workersInvocationsAdaptive` alias accepts is 4w4d (measured); 30 days stays inside it. */
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

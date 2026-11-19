/** `12.4B`, `830M`, `12K`. */
export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1).replace(/\.0$/, '')}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`
  return String(Math.round(n))
}

/** `2026-10` → `October`. */
export function monthName(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString('en', { month: 'long', timeZone: 'UTC' })
}

/**
 * The request count `percent` above `total`, rounded to two significant
 * figures' worth of steps (0.1B for a 9B month), so the label says the round
 * number picked: +10% reads "10% more", never "9%".
 */
export function limitAbove(total: number, percent: number): number {
  const step = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(total, 1))) - 1)
  return Math.max(step, Math.round((total * (1 + percent / 100)) / step) * step)
}

export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

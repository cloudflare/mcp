/**
 * Counts at any size: K, M, B, T. `fmt` is a value the user picked (a
 * multiple of a nice step), in its shortest exact form; `sig` a measured
 * value to `n` significant digits; `words` the same for screen readers.
 */
const UNITS = [
  [1e12, 'T', 'trillion'],
  [1e9, 'B', 'billion'],
  [1e6, 'M', 'million'],
  [1e3, 'K', 'thousand'],
  [1, '', '']
] as const
const unitOf = (v: number) => UNITS.find(([u]) => Math.abs(v) >= u * 0.9995) ?? UNITS[4]
const trim = (t: string) => (t.includes('.') ? t.replace(/\.?0+$/, '') : t)

export function fmt(v: number): string {
  if (!v) return '0'
  const [u, s] = unitOf(v)
  const x = v / u
  let d = 0
  while (d < 3 && Math.abs(x * 10 ** d - Math.round(x * 10 ** d)) > 1e-6) d++
  return trim(x.toFixed(d)) + s
}

export function sig(v: number, n = 2): string {
  if (!v) return '0'
  const [u, s] = unitOf(v)
  const x = v / u
  return trim(x.toFixed(Math.max(0, n - 1 - Math.floor(Math.log10(x) + 1e-9)))) + s
}

export function words(v: number): string {
  const [u, , w] = unitOf(v)
  return (u === 1 ? String(Math.round(v)) : fmt(v).replace(/[KMBT]$/, '')) + (w ? ` ${w}` : '')
}

/** `2026-11-03` → `Nov 3`. */
export const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleString('en', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC'
  })

/** `2026-11` → `Nov`. */
export const monthShort = (k: string) =>
  new Date(`${k}-15T00:00:00Z`).toLocaleString('en', { month: 'short', timeZone: 'UTC' })

export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

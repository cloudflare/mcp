import { appLocale } from '../../mcp-apps/app-shell/apply-locale'

/**
 * Counts and dates in the host's formats, from the browser's `Intl`: no
 * catalog, and every locale's separators, digits and compact units for free
 * ("1.35B", "1,35B", "١٫٣٥B"). Formatters are built once per locale.
 *
 * `fmt` is a value the user picked (a multiple of a nice step), in its
 * shortest exact form; `sig` a measured value to `n` significant digits;
 * `approx` either with the locale's "about" sign; `words` the long form for
 * screen readers ("1.35 billion").
 */
const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>()
function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat>(
  key: string,
  make: (lang: string) => T
): T {
  const lang = appLocale().formats
  const k = `${lang}|${key}`
  let f = cache.get(k) as T | undefined
  if (!f) cache.set(k, (f = make(lang)))
  return f
}
const number = (key: string, options: Intl.NumberFormatOptions) =>
  cached(key, (lang) => new Intl.NumberFormat(lang, { notation: 'compact', ...options }))
const date = (key: string, options: Intl.DateTimeFormatOptions) =>
  cached(
    key,
    (lang) => new Intl.DateTimeFormat(lang, { calendar: 'gregory', timeZone: 'UTC', ...options })
  )

export const fmt = (v: number) => number('fmt', { maximumFractionDigits: 3 }).format(v)
export const sig = (v: number, n = 2) =>
  number(`sig${n}`, { maximumSignificantDigits: n }).format(v)
/** "~1.35B": `formatRange` of one value is the locale's approximate form. */
export const approx = (v: number, n?: number) =>
  number(
    n ? `sig${n}` : 'fmt',
    n ? { maximumSignificantDigits: n } : { maximumFractionDigits: 3 }
  ).formatRange(v, v)
export const words = (v: number) =>
  number('words', { compactDisplay: 'long', maximumFractionDigits: 3 }).format(v)

const utc = (d: string) => new Date(`${d}T00:00:00Z`)
/** `2026-11-03` → `Nov 3` (`3 Nov` in en-GB). */
export const fmtDay = (d: string) => date('day', { month: 'short', day: 'numeric' }).format(utc(d))
/** `2026-11-03`, `2026-11-09` → `Nov 3 – 9`, the month once when both share it. */
export const fmtDays = (from: string, to: string) =>
  date('day', { month: 'short', day: 'numeric' }).formatRange(utc(from), utc(to))
/** `2026-11` → `Nov`. */
export const monthShort = (k: string) => date('month', { month: 'short' }).format(utc(`${k}-15`))

/** The threshold in a policy's name ("Workers requests over 1.35B in 7 days"): stored, so never localized. */
const POLICY = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 3 })
export const fmtPolicy = (v: number) => POLICY.format(v)

export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

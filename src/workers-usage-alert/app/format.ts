import { appLocale } from '../../mcp-apps/app-shell/apply-locale'
import { byteScale, policyNumber } from '../../threshold-alert/units'
import type { UnitFormat } from '../../threshold-alert/units'

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
const numbers = new Map<string, Intl.NumberFormat>()
const dates = new Map<string, Intl.DateTimeFormat>()
function cached<T>(cache: Map<string, T>, key: string, make: (lang: string) => T): T {
  const lang = appLocale().formats
  const k = `${lang}|${key}`
  let f = cache.get(k)
  if (!f) {
    f = make(lang)
    cache.set(k, f)
  }
  return f
}
const number = (key: string, options: Intl.NumberFormatOptions) =>
  cached(numbers, key, (lang) => new Intl.NumberFormat(lang, { notation: 'compact', ...options }))
const date = (key: string, options: Intl.DateTimeFormatOptions) =>
  cached(
    dates,
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
export const fmtPolicy = (v: number) => policyNumber(v, 'count')

/** Bytes in the unit they read best in, in the host's formats: "1.5 TB", "1,5 To". */
const bytes = (
  v: number,
  key: string,
  options: Intl.NumberFormatOptions,
  display: 'short' | 'long' = 'short'
) => {
  const unit = byteScale(v)[1]
  return cached(
    numbers,
    `bytes|${key}|${unit}|${display}`,
    (lang) => new Intl.NumberFormat(lang, { style: 'unit', unit, unitDisplay: display, ...options })
  )
}

/** The formatters for one unit, so a card counts requests or bytes with the same calls. */
export interface Formats {
  readonly fmt: (v: number) => string
  readonly sig: (v: number, n?: number) => string
  readonly approx: (v: number, n?: number) => string
  readonly words: (v: number) => string
  readonly policy: (v: number) => string
}

const COUNT: Formats = { fmt, sig, approx, words, policy: fmtPolicy }
const BYTES: Formats = {
  fmt: (v) => bytes(v, 'fmt', { maximumFractionDigits: 3 }).format(byteScale(v)[0]),
  sig: (v, n = 2) => bytes(v, `sig${n}`, { maximumSignificantDigits: n }).format(byteScale(v)[0]),
  approx: (v, n) => {
    const x = byteScale(v)[0]
    return bytes(
      v,
      n ? `sig${n}` : 'fmt',
      n ? { maximumSignificantDigits: n } : { maximumFractionDigits: 3 }
    ).formatRange(x, x)
  },
  words: (v) => bytes(v, 'words', { maximumFractionDigits: 3 }, 'long').format(byteScale(v)[0]),
  policy: (v) => policyNumber(v, 'bytes')
}

/**
 * US cents as dollars, in the host's formats: "$50", "$1.2K", "50 US-Dollar".
 * Under $1,000 a value shows its cents only when it has them; above, the
 * locale's compact form.
 */
const usd = (key: string, options: Intl.NumberFormatOptions, display?: 'name') =>
  cached(
    numbers,
    `usd|${key}|${display ?? ''}`,
    (lang) =>
      new Intl.NumberFormat(lang, {
        style: 'currency',
        currency: 'USD',
        currencyDisplay: display ?? 'symbol',
        ...options
      })
  )
const dollars = (cents: number) => cents / 100
const small = (cents: number) => Math.abs(cents) < 100_000
/** Whole dollars without cents; any cents as two digits ("$42.50", never "$42.5"). */
const cents = (v: number) => (Math.round(v) % 100 === 0 ? 0 : 2)
const CENTS: Formats = {
  fmt: (v) =>
    small(v)
      ? usd(`fmt${cents(v)}`, {
          maximumFractionDigits: cents(v),
          minimumFractionDigits: cents(v)
        }).format(dollars(v))
      : usd('fmt-c', { notation: 'compact', maximumFractionDigits: 2 }).format(dollars(v)),
  sig: (v, n = 2) =>
    usd(`sig${n}`, { notation: 'compact', maximumSignificantDigits: Math.max(n, 2) }).format(
      dollars(v)
    ),
  approx: (v, n) => {
    const f = usd(n ? `sig${n}` : 'fmt-c', {
      notation: 'compact',
      ...(n ? { maximumSignificantDigits: Math.max(n, 2) } : { maximumFractionDigits: 2 })
    })
    return f.formatRange(dollars(v), dollars(v))
  },
  words: (v) =>
    usd(
      `words${cents(v)}`,
      { maximumFractionDigits: cents(v), minimumFractionDigits: cents(v) },
      'name'
    ).format(dollars(v)),
  policy: (v) => policyNumber(v, 'cents')
}

export const formatsFor = (format: UnitFormat): Formats =>
  format === 'bytes' ? BYTES : format === 'cents' ? CENTS : COUNT

export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

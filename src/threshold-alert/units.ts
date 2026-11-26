/**
 * What a threshold counts, and how to write one of it. Pure: the view, the
 * presets and the collector all format with it, so the card, the policy's
 * stored name and the model's text agree.
 */

/**
 * `count`: a plain number (requests). `bytes`: decimal bytes (1 GB is 10⁹), as
 * R2 bills. `cents`: US cents, as spend policies take them, written as dollars.
 */
export type UnitFormat = 'count' | 'bytes' | 'cents'

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte', 'petabyte'] as const

/** A byte count as the unit it reads best in: `[1.5, 'terabyte']`. */
export function byteScale(bytes: number): [number, (typeof BYTE_UNITS)[number]] {
  const exp = bytes > 0 ? Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log10(bytes) / 3)) : 0
  return [bytes / 1000 ** Math.max(0, exp), BYTE_UNITS[Math.max(0, exp)]]
}

const POLICY_COUNT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 3 })
const dollarsIn = (digits: number) =>
  new Intl.NumberFormat('en', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  })
const POLICY_DOLLARS = dollarsIn(0)
const POLICY_DOLLARS_CENTS = dollarsIn(2)

/**
 * The threshold in a policy's stored name ("over 1.35B", "over 1.5 TB",
 * "over $50"): stored in Cloudflare and read by everyone on the account, so
 * never localized.
 */
export function policyNumber(value: number, format: UnitFormat): string {
  if (format === 'count') {
    return POLICY_COUNT.format(value)
  }
  if (format === 'cents') {
    // Whole dollars without cents; any cents as two digits ("$42.50", never "$42.5").
    const f = Math.round(value) % 100 === 0 ? POLICY_DOLLARS : POLICY_DOLLARS_CENTS
    return f.format(value / 100)
  }
  const [x, unit] = byteScale(value)
  return new Intl.NumberFormat('en', {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: 3
  }).format(x)
}

/**
 * An exact value for the model: "1,500,000,000,000 bytes (1.5 TB)",
 * "5,000 cents ($50)" or "1,350,000,000".
 */
export function exactNumber(value: number, format: UnitFormat): string {
  const exact = Math.round(value).toLocaleString('en')
  if (format === 'count') {
    return exact
  }
  return `${exact} ${format === 'cents' ? 'cents' : 'bytes'} (${policyNumber(value, format)})`
}

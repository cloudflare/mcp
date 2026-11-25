/**
 * The rows on screen as text, for the copy trio. Raw values, as the table
 * shows them: Markdown right-aligns a column whose values are all numbers.
 * Pure, so tests import it.
 */
import type { D1Cell } from '../contract'
import type { CopyFormat } from './machines'

export const FORMAT_LABEL: Record<CopyFormat, string> = {
  markdown: 'Markdown',
  csv: 'CSV',
  json: 'JSON'
}

const text = (v: D1Cell) => (v === null ? 'NULL' : String(v))

export function serializeRows(
  format: CopyFormat,
  columns: readonly string[],
  rows: readonly (readonly D1Cell[])[]
): string {
  if (format === 'json')
    return JSON.stringify(
      rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i] ?? null]))),
      null,
      2
    )
  if (format === 'csv') {
    const q = (v: D1Cell | string) => {
      const s = v === null ? '' : String(v)
      return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
    }
    return [
      columns.map(q).join(','),
      ...rows.map((row) => columns.map((_, i) => q(row[i] ?? null)).join(','))
    ].join('\n')
  }
  const esc = (s: string) => s.replaceAll('|', '\\|').replace(/\r?\n/g, ' ')
  const numeric = columns.map(
    (_, i) => rows.length > 0 && rows.every((r) => r[i] === null || typeof r[i] === 'number')
  )
  return [
    `| ${columns.map(esc).join(' | ')} |`,
    `| ${numeric.map((n) => (n ? '---:' : '---')).join(' | ')} |`,
    ...rows.map((row) => `| ${columns.map((_, i) => esc(text(row[i] ?? null))).join(' | ')} |`)
  ].join('\n')
}

const nf = new Intl.NumberFormat()
/** A count, grouped in the host's locale. */
export const count = (n: number) => nf.format(n)

/** A duration in the receipt's words: `0.5 ms`, `1.25 s`. */
export function duration(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toFixed(2)} s`
}

/** The SQLite type a column's first non-NULL value has, for the header's tooltip. */
export function columnType(rows: readonly (readonly D1Cell[])[], column: number): string {
  const v = rows.find((r) => r[column] !== null && r[column] !== undefined)?.[column]
  if (v === undefined || v === null) return 'NULL'
  if (typeof v === 'number') return Number.isInteger(v) ? 'INTEGER' : 'REAL'
  if (typeof v === 'boolean') return 'INTEGER'
  return 'TEXT'
}

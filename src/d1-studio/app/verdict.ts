import { blankLiterals, classifyStatement, closest } from '../statement'

export { closest }

/**
 * What an edited draft is, in words the view can say where the SQL is. It
 * reads `classifyStatement`, the guarantee, unchanged, and only splits its "not one read" answers finer: a read with text after its
 * `;`, several statements, a first word that is no statement (a typo the
 * classifier calls a write), and a real write. Nothing here lets anything run
 * that `classifyStatement` refuses.
 */

/** Statement words SQLite knows. A first word outside these is a typo, not a write. */
const READ_WORDS = ['SELECT', 'WITH', 'VALUES', 'EXPLAIN', 'PRAGMA']
const WRITE_WORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'UPSERT',
  'DROP',
  'ALTER',
  'CREATE',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'REINDEX',
  'ANALYZE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'PRAGMA'
])

/** A span of the draft, `[start, end)`. */
export type Span = readonly [number, number]

export type Verdict =
  | { readonly kind: 'read' }
  | { readonly kind: 'empty' }
  /** One read, then text after its `;` that isn't a statement. `keep` is the read; `mark` the rest. */
  | { readonly kind: 'tail'; readonly keep: string; readonly mark: Span }
  /** Several statements. `keep` is the first; `mark` covers the others. */
  | {
      readonly kind: 'multiple'
      readonly count: number
      readonly keep: string
      readonly mark: Span
    }
  /** The first word is no SQL statement. */
  | { readonly kind: 'typo'; readonly word: string; readonly suggest?: string; readonly mark: Span }
  /** A statement that changes the database. */
  | { readonly kind: 'write'; readonly keyword: string; readonly mark: Span }

export function verdictOf(sql: string): Verdict {
  const c = classifyStatement(sql)
  if (c.kind === 'read') return { kind: 'read' }
  if (c.kind === 'empty') return { kind: 'empty' }
  const code = blankLiterals(sql)
  if (c.kind === 'multiple') {
    // The first top-level `;` (literals are blanked, so a `;` in a string doesn't count).
    const semi = code.indexOf(';')
    const keep = sql.slice(0, semi + 1)
    const rest = sql.slice(semi + 1)
    const restStart = semi + 1 + (rest.length - rest.trimStart().length)
    const pieces = code
      .slice(semi + 1)
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
    const looksLikeStatement = (p: string) => {
      const w = p.match(/^[A-Za-z]+/)?.[0]?.toUpperCase()
      return !!w && (READ_WORDS.includes(w) || WRITE_WORDS.has(w))
    }
    const mark: Span = [restStart, sql.trimEnd().length]
    if (classifyStatement(keep).kind === 'read' && !pieces.some(looksLikeStatement))
      return { kind: 'tail', keep, mark }
    return { kind: 'multiple', count: pieces.length + 1, keep, mark }
  }
  const lead = sql.length - sql.trimStart().length
  if (WRITE_WORDS.has(c.keyword)) {
    const at = code.toUpperCase().search(new RegExp(`\\b${c.keyword}\\b`))
    return { kind: 'write', keyword: c.keyword, mark: [at, at + c.keyword.length] }
  }
  const word = sql.slice(lead).match(/^\S+/)?.[0] ?? c.keyword
  const suggest = closest(word, READ_WORDS)
  return {
    kind: 'typo',
    word,
    ...(suggest ? { suggest } : {}),
    mark: [lead, lead + word.length]
  }
}

/** What the reason line says, in one short sentence. Empty for a read or an empty draft. */
export function reasonOf(v: Verdict): string {
  switch (v.kind) {
    case 'tail':
      return 'Text after the ; isn’t SQL. Run takes one statement.'
    case 'multiple':
      return `${v.count === 2 ? 'Two' : v.count} statements. Run takes one at a time.`
    case 'typo':
      return `${v.word} isn’t a SQL statement.`
    case 'write':
      return `${v.keyword} changes data. The view only reads; the agent runs it once you approve.`
    default:
      return ''
  }
}

/** The fix the reason line offers, as the draft it would leave. */
export function fixOf(v: Verdict, draft: string): { label: string; sql: string } | undefined {
  if (v.kind === 'tail') return { label: 'Remove it', sql: v.keep }
  if (v.kind === 'multiple') return { label: 'Keep the first', sql: v.keep }
  if (v.kind === 'typo' && v.suggest)
    return {
      label: `Use ${v.suggest}`,
      sql: draft.slice(0, v.mark[0]) + v.suggest + draft.slice(v.mark[1])
    }
  return undefined
}

/** The span the editor marks with a wavy underline. */
export function markOf(v: Verdict): Span | undefined {
  return v.kind === 'tail' || v.kind === 'multiple' || v.kind === 'typo' ? v.mark : undefined
}

/** The query's own LIMIT and OFFSET. */
export function limitOf(sql: string): { limit?: number; offset: number } {
  const code = blankLiterals(sql)
  const m = code.match(/\bLIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?\s*;?\s*$/i)
  if (!m) return { offset: 0 }
  return { limit: Number(m[1]), offset: Number(m[2] ?? 0) }
}

/** The same read with its final LIMIT's OFFSET set (0: none), written in place so the rest of the SQL stays as it was. */
export function withOffset(sql: string, offset: number): string {
  const code = blankLiterals(sql)
  const m = /\bLIMIT\s+(\d+)(?:\s+OFFSET\s+\d+)?(?=\s*;?\s*$)/i.exec(code)
  if (!m) return sql
  const limit = m[1]!
  return (
    sql.slice(0, m.index) +
    (offset ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`) +
    sql.slice(m.index + m[0].length)
  )
}

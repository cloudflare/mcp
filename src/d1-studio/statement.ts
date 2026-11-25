/**
 * What a SQL text is, for D1 Studio: one read the App may run, or something
 * it must not. Shared by the tool (which refuses anything but a read before
 * any request) and the view (which offers Run for a read and "Send to chat"
 * for a write). The tool's check is the guarantee; the view's is for the
 * button.
 *
 * D1's query endpoints have no read-only mode, so this is a deliberately
 * conservative lexical check, not a parser: strings, quoted identifiers and
 * comments are blanked out first, then the text must be one statement that
 * starts like a read and names no statement that writes anywhere (SQLite
 * allows `WITH … DELETE`). A read it can't prove is refused, never run.
 */

/** Why a text is not a read the App may run. */
export type StatementKind =
  | { readonly kind: 'read' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'multiple' }
  | { readonly kind: 'write'; readonly keyword: string }

/**
 * Keywords that start, or are part of, a statement that changes the database
 * or the connection, wherever they appear. `END` isn't here: inside a read it
 * is only `CASE … END`, and `END [TRANSACTION]` has to start the statement,
 * which the first-word check below refuses.
 */
const WRITE_KEYWORDS = [
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
  'RELEASE'
] as const

/** Pragmas that only report. Any other pragma, or one with `=`, may change a setting. */
const READ_PRAGMAS = new Set([
  'table_info',
  'table_xinfo',
  'table_list',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'function_list',
  'collation_list'
])

/**
 * The text with every string literal, quoted identifier and comment replaced
 * by spaces of the same length, so keywords inside them aren't seen and
 * offsets still line up.
 */
export function blankLiterals(sql: string): string {
  return sql.replace(
    /'(?:[^']|'')*'?|"(?:[^"]|"")*"?|`[^`]*`?|\[[^\]]*\]?|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g,
    (m) => m.replace(/[^\n]/g, ' ')
  )
}

/**
 * Classify `sql` as one read, or say why it isn't one.
 *
 * @param sql - The statement as the user or agent wrote it.
 */
export function classifyStatement(sql: string): StatementKind {
  const code = blankLiterals(sql)
  const statements = code
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!statements.length) return { kind: 'empty' }
  if (statements.length > 1) return { kind: 'multiple' }
  const statement = statements[0]!
  const upper = statement.toUpperCase()

  for (const keyword of WRITE_KEYWORDS) {
    // Every occurrence: `replace(…)` is a string function, not REPLACE INTO, but one doesn't vouch for a later one.
    for (const at of upper.matchAll(new RegExp(`\\b${keyword}\\b(\\s*\\()?`, 'g')))
      if (!(keyword === 'REPLACE' && at[1])) return { kind: 'write', keyword }
  }

  const first = upper.match(/^[A-Z]+/)?.[0]
  if (first === 'SELECT' || first === 'WITH' || first === 'VALUES' || first === 'EXPLAIN')
    return { kind: 'read' }
  if (first === 'PRAGMA') {
    const pragma = statement.match(/^PRAGMA\s+(?:\w+\.)?(\w+)\s*(\(|$)/i)
    if (pragma && READ_PRAGMAS.has(pragma[1]!.toLowerCase())) return { kind: 'read' }
    return { kind: 'write', keyword: 'PRAGMA' }
  }
  return { kind: 'write', keyword: first ?? statement.slice(0, 12) }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Where `name` (such as `a.start_at`) is a whole identifier in `sql`: not
 * part of a longer name, and outside strings, quoted names and comments.
 */
function identifierSpans(sql: string, name: string): number[] {
  if (!name) return []
  const re = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, 'gi')
  return [...blankLiterals(sql).matchAll(re)].map((m) => m.index)
}

/** Whether `sql` names `name` as a whole identifier (see {@link replaceIdentifier}). */
export function hasIdentifier(sql: string, name: string): boolean {
  return identifierSpans(sql, name).length > 0
}

/** `sql` with each whole-identifier `name` replaced by `use`; text inside strings and comments stays as it was. */
export function replaceIdentifier(sql: string, name: string, use: string): string {
  let out = sql
  for (const at of identifierSpans(sql, name).reverse())
    out = out.slice(0, at) + use + out.slice(at + name.length)
  return out
}

/** Whether the App may run `sql` itself. */
export function isReadStatement(sql: string): boolean {
  return classifyStatement(sql).kind === 'read'
}

/**
 * The identifier a D1 error names (`no such column: a.start_at`), so the
 * view can underline it in the SQL. Undefined when the error names none.
 */
export function errorToken(message: string): string | undefined {
  return message.match(/no such (?:column|table|function): ([\w.]+)/i)?.[1]
}

/** D1's error message without its wrapper: `D1_ERROR: … : SQLITE_ERROR` becomes `…`. */
export function cleanD1Error(message: string): string {
  return message
    .replace(/^D1_ERROR:\s*/i, '')
    .replace(/:\s*SQLITE_[A-Z_]+$/, '')
    .trim()
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    prev = row
  }
  return prev[b.length]!
}

/** The name in `names` within two edits of `word`, ignoring case (the nearest), or undefined. */
export function closest(word: string, names: readonly string[]): string | undefined {
  let best: string | undefined
  let bestD = 3
  for (const n of names) {
    if (n.toLowerCase() === word.toLowerCase()) continue
    const d = editDistance(word.toLowerCase(), n.toLowerCase())
    if (d < bestD) {
      best = n
      bestD = d
    }
  }
  return best
}

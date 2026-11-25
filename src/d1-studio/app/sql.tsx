import type { ReactNode } from 'react'

/**
 * SQL in the dashboard Studio's colours (stratus
 * `common/components/Studio/components/SQLEditor/SQLThemePlugin.tsx`):
 * keywords and built-in functions, strings, numbers, operators, and the
 * database's own table names (pink, as `SQLiteTableNameHighlightPlugin`).
 * A tokenizer, not a parser: colouring is all it does.
 */
const KEYWORDS = new Set(
  `ABORT ACTION ADD AFTER ALL ALTER ANALYZE AND AS ASC ATTACH AUTOINCREMENT BEFORE BEGIN BETWEEN BY
  CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS CURRENT_DATE
  CURRENT_TIME CURRENT_TIMESTAMP DEFAULT DEFERRABLE DEFERRED DELETE DESC DETACH DISTINCT DO DROP EACH
  ELSE END ESCAPE EXCEPT EXCLUSIVE EXISTS EXPLAIN FAIL FALSE FILTER FOR FOREIGN FROM FULL GLOB GROUP
  HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS ISNULL
  JOIN KEY LEFT LIKE LIMIT MATCH NATURAL NO NOT NOTHING NOTNULL NULL OF OFFSET ON OR ORDER OUTER OVER
  PLAN PRAGMA PRIMARY QUERY RAISE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT
  RETURNING RIGHT ROLLBACK ROW ROWS SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TO TRANSACTION
  TRIGGER TRUE UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT
  ABS AVG COALESCE COUNT DATE DATETIME GROUP_CONCAT IFNULL IIF JSON_EXTRACT JULIANDAY LENGTH LOWER MAX
  MIN ROUND STRFTIME SUBSTR SUM TIME TOTAL TRIM TYPEOF UNIXEPOCH UPPER`.split(/\s+/)
)

const TOKEN =
  /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?|`[^`]*`?)|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)|(\b\d+(?:\.\d+)?\b)|([*=<>!+\-/%|]+)/g

export interface HighlightOptions {
  /** The database's table and view names, lower case. */
  readonly tables: ReadonlySet<string>
  /** An identifier a D1 error names, underlined in red. */
  readonly squiggle?: string
}

/** The SQL as coloured spans. */
export function highlightSql(sql: string, { tables, squiggle }: HighlightOptions): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of sql.matchAll(TOKEN)) {
    const at = m.index
    if (at > last) out.push(sql.slice(last, at))
    const [text, comment, string, quoted, word, number, op] = m
    const bare = quoted ? quoted.replace(/^["`]|["`]$/g, '') : word
    const kind =
      squiggle && bare === squiggle
        ? 'err'
        : comment
          ? 'c'
          : string
            ? 's'
            : number
              ? 'n'
              : op
                ? 'o'
                : // A table is marked where it stands alone, not as the qualifier in `t.column`, as in Studio.
                  bare && !bare.includes('.') && tables.has(bare.toLowerCase())
                  ? 't'
                  : word && KEYWORDS.has(word.toUpperCase())
                    ? 'k'
                    : null
    out.push(
      kind ? (
        <span key={at} className={`dq-${kind}`}>
          {text}
        </span>
      ) : (
        text
      )
    )
    last = at + text.length
  }
  if (last < sql.length) out.push(sql.slice(last))
  return out
}

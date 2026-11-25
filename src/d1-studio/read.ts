/**
 * D1 reads for the D1 Studio tool: the database's name, its table names, and
 * the agent's queries, each run with `/raw` (columns and rows as arrays).
 * Only statements `classifyStatement` proves are reads reach this module.
 */
import { z } from 'zod'
import { ApiReadUnsupported, type ApiReader } from '../mcp-apps/api-read'
import type { D1Outcome } from './contract'
import { rawOutcome } from './raw'
import { blankLiterals, closest } from './statement'

/** The table listing the tool runs when the agent gives no SQL, and the source of table names for highlighting. */
export const TABLES_SQL = `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name;`

const DatabaseBody = z.object({ result: z.object({ name: z.string() }) })

/**
 * Run one read with `/raw`. A SQL error is an outcome; a refusal throws, so
 * the whole call becomes the explained tool error with its step-up.
 *
 * @throws {ApiReadError} when Cloudflare refuses the credential.
 */
export async function runRead(
  reader: ApiReader,
  accountId: string,
  databaseId: string,
  sql: string
): Promise<D1Outcome> {
  try {
    const { status, body } = await reader.postRead(
      `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/raw`,
      { sql }
    )
    return rawOutcome(status, body)
  } catch (error) {
    if (error instanceof ApiReadUnsupported) return { status: 'failed', error: error.message }
    throw error
  }
}

/**
 * The database's name, which also proves the account and database exist.
 *
 * @throws {ApiReadError} for a refusal or an unknown database.
 */
export async function readDatabaseName(
  reader: ApiReader,
  accountId: string,
  databaseId: string
): Promise<string> {
  const body = await reader.get(
    `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}`,
    DatabaseBody
  )
  return body.result.name
}

/** The table and view names in a `TABLES_SQL` outcome. */
export function tableNames(outcome: D1Outcome): string[] {
  if (outcome.status !== 'rows') return []
  const at = outcome.columns.indexOf('name')
  return at < 0 ? [] : outcome.rows.flatMap((row) => (typeof row[at] === 'string' ? [row[at]] : []))
}

/** The tables (of `tables`) a statement names after FROM or JOIN, with their aliases. */
export function tablesIn(
  sql: string,
  tables: readonly string[]
): { table: string; alias?: string }[] {
  const known = new Map(tables.map((t) => [t.toLowerCase(), t]))
  const out: { table: string; alias?: string }[] = []
  for (const m of blankLiterals(sql).matchAll(
    /\b(?:FROM|JOIN)\s+([A-Za-z_][\w]*)(?:\s+(?:AS\s+)?(?!(?:WHERE|JOIN|LEFT|RIGHT|FULL|OUTER|INNER|CROSS|ON|GROUP|ORDER|LIMIT|HAVING|UNION|EXCEPT|INTERSECT|WINDOW|RETURNING|INDEXED|NOT|USING|NATURAL)\b)([A-Za-z_]\w*))?/gi
  )) {
    const table = known.get(m[1]!.toLowerCase())
    if (table) out.push({ table, ...(m[2] && { alias: m[2] }) })
  }
  return out
}

/**
 * For a failed outcome that names an unknown column or table, the name it
 * most likely meant: a column of the tables the SQL reads (one
 * `PRAGMA table_info` each), or a table. Best effort: anything that fails
 * leaves the outcome as it was.
 */
export async function withFix(
  reader: ApiReader,
  accountId: string,
  databaseId: string,
  sql: string,
  outcome: D1Outcome,
  tables: readonly string[]
): Promise<D1Outcome> {
  if (outcome.status !== 'failed' || !outcome.token) return outcome
  const kind = outcome.error.match(/no such (column|table)/i)?.[1]?.toLowerCase()
  if (kind === 'table') {
    const use = closest(outcome.token, tables)
    return use ? { ...outcome, fix: { use } } : outcome
  }
  if (kind !== 'column') return outcome
  const [prefix, name] = outcome.token.includes('.')
    ? (outcome.token.split('.', 2) as [string, string])
    : [undefined, outcome.token]
  const named = tablesIn(sql, tables).filter(
    (t) =>
      !prefix ||
      t.alias?.toLowerCase() === prefix.toLowerCase() ||
      t.table.toLowerCase() === prefix.toLowerCase()
  )
  try {
    for (const { table } of named.slice(0, 4)) {
      const info = await runRead(
        reader,
        accountId,
        databaseId,
        `PRAGMA table_info(${JSON.stringify(table)});`
      )
      if (info.status !== 'rows') continue
      const at = info.columns.indexOf('name')
      const columns = info.rows.flatMap((r) => (typeof r[at] === 'string' ? [r[at]] : []))
      const use = closest(name, columns)
      if (use) return { ...outcome, fix: { use: prefix ? `${prefix}.${use}` : use, table } }
    }
  } catch {
    // The fix is a hint: a refused or failed lookup leaves the outcome as D1 gave it.
  }
  return outcome
}

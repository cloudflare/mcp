import type { App } from '@modelcontextprotocol/ext-apps'
import { MAX_ROWS, type D1Cell, type D1Outcome, type D1StudioResult } from '../contract'
import type { Sort } from './machines'
import { rawOutcome } from '../raw'
import { blankLiterals, isReadStatement } from '../statement'

/** The generated direct tool the view re-runs reads with (`appTools` in `../tool.ts`). */
export const RUN_TOOL = 'd1_raw'

/**
 * How long a read from the view waits for its answer: just past D1's own 30 s
 * query limit, so a read D1 is still running isn't cut short, and one the host
 * lost doesn't wait the SDK's 60 s.
 */
export const READ_TIMEOUT_MS = 35_000

/** What the host can do for the view, read once from its capabilities. */
export interface HostAbilities {
  /** Run reads in the view (`callServerTool`). */
  readonly run: boolean
  /** Hand a write to the chat (`ui/message`). */
  readonly send: boolean
  readonly fullscreen: boolean
  readonly openLinks: boolean
  /** Tell the model what the view now shows (`ui/update-model-context`). */
  readonly context: boolean
  /**
   * Edit the SQL in fullscreen, not in the card: Claude sends freeform text
   * entry to the chat or fullscreen, where ChatGPT allows basic edits inline.
   * Only where fullscreen is offered; elsewhere the card edits in place.
   */
  readonly editInFullscreen: boolean
}

/** Claude (claude.ai, the desktop and mobile apps), by the name it gives in `ui/initialize`. */
export const isClaudeHost = (name: string | undefined) => !!name && /claude/i.test(name)

export function hostAbilities(app: App): HostAbilities {
  const caps = app.getHostCapabilities()
  const fullscreen = !!app.getHostContext()?.availableDisplayModes?.includes('fullscreen')
  return {
    run: !!caps?.serverTools,
    send: !!caps?.message,
    fullscreen,
    openLinks: !!caps?.openLinks,
    context: !!caps?.updateModelContext,
    editInFullscreen: fullscreen && isClaudeHost(app.getHostVersion()?.name)
  }
}

/**
 * The text of a host tool error. A result with `isError` is the server's
 * explained error (a refusal, a step-up); the host's own failures throw.
 */
const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.flatMap((c) => (c.type === 'text' && c.text ? [c.text] : [])).join('\n')

/**
 * Run one read through the host with `d1_raw`. A SQL error is an outcome;
 * anything the host or server refused rejects, so the card shows it as a
 * failed run, not as D1's answer.
 *
 * @throws {Error} when the statement isn't a read (never sent), the host fails, or the server refuses.
 */
export async function runRead(
  app: App,
  database: D1StudioResult['database'],
  sql: string,
  signal?: AbortSignal
): Promise<D1Outcome> {
  if (!isReadStatement(sql)) throw new Error('Only a single read runs here.')
  const r = await app
    .callServerTool(
      {
        name: RUN_TOOL,
        arguments: {
          path: { account_id: database.accountId, database_id: database.id },
          body: { sql }
        }
      },
      { signal, timeout: READ_TIMEOUT_MS }
    )
    .catch((error: unknown) => {
      // The SDK's "Request timed out", in the view's words; an abort (Revert, a newer read) stays as it is.
      if (
        !signal?.aborted &&
        /timed out/i.test(error instanceof Error ? error.message : String(error))
      )
        throw new Error(`No answer from D1 in ${READ_TIMEOUT_MS / 1000} s.`)
      throw error
    })
  const text = textOf(r)
  if (!r.isError) {
    const body = parseJson(text)
    if (body === undefined) throw new Error('D1 returned an unexpected response.')
    return rawOutcome(200, body)
  }
  // A SQL error is a tool error: `Cloudflare API error: POST … returned HTTP 400.`, a blank line, then D1's
  // body. A refusal's paragraphs explain it instead, so it stays the host's error.
  const status = Number(text.match(/returned HTTP (\d{3})/)?.[1])
  const body = parseJson(text.split('\n\n')[1])
  if (status === 400 && body !== undefined) {
    const outcome = rawOutcome(status, body)
    if (outcome.status === 'failed') return outcome
  }
  throw new Error(text || 'The query failed.')
}

/**
 * The SQL that reads `limit` rows of `sql`'s result from `offset`, sorted by
 * D1 when `sort` is given: the agent's query as a subquery, so the whole
 * result is ranked and paged, not just the rows the view holds. Columns are
 * named by position, since a result's names can repeat. NULLs last both ways,
 * as the view sorts.
 *
 * @returns `undefined` when the query can't be wrapped (it isn't a SELECT, VALUES or WITH).
 */
export function sliceSql(
  sql: string,
  { sort, limit, offset }: { sort: Sort; limit: number; offset: number }
): string | undefined {
  // Without its final `;`, also when a comment follows it (comments and strings are blanked to find it).
  const code = blankLiterals(sql).trimEnd()
  const inner = sql.slice(0, code.endsWith(';') ? code.length - 1 : code.length).trim()
  if (!/^(?:SELECT|VALUES|WITH)\b/i.test(inner.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '')))
    return undefined
  const order = sort
    ? ` ORDER BY ${sort.column + 1} ${sort.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`
    : ''
  const out = `SELECT * FROM (\n${inner}\n)${order} LIMIT ${limit} OFFSET ${offset}`
  return isReadStatement(out) ? out : undefined
}

/**
 * Read more of a result in the view: a block past those held, or the whole
 * result sorted by D1, `limit` rows (at most `MAX_ROWS`, all an outcome holds).
 *
 * @throws {Error} when the query can't be wrapped, the host fails, or D1 refuses it.
 */
export async function readSlice(
  app: App,
  database: D1StudioResult['database'],
  sql: string,
  slice: { sort: Sort; offset: number; limit?: number },
  signal?: AbortSignal
): Promise<readonly (readonly D1Cell[])[]> {
  const wrapped = sliceSql(sql, { limit: MAX_ROWS, ...slice })
  if (!wrapped) throw new Error('This query can’t be read a page at a time here.')
  const outcome = await runRead(app, database, wrapped, signal)
  if (outcome.status === 'failed') throw new Error(outcome.error)
  return outcome.rows
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Hand a write to the chat as the user's next message, for the agent to run once the user approves. */
export async function sendToChat(
  app: App,
  database: D1StudioResult['database'],
  sql: string
): Promise<void> {
  const r = await app.sendMessage({
    role: 'user',
    content: [
      {
        type: 'text',
        text: `Run this on the D1 database ${database.name} (${database.id}):\n\n\`\`\`sql\n${sql.trim()}\n\`\`\``
      }
    ]
  })
  if (r.isError) throw new Error('The host did not accept the message.')
}

/** The database in the dashboard's Studio (stratus `pages/d1/routes.ts`). */
export function studioUrl(database: D1StudioResult['database']): string {
  return `https://dash.cloudflare.com/${encodeURIComponent(database.accountId)}/workers/d1/databases/${encodeURIComponent(database.id)}/studio`
}

/**
 * `limit` rows of `sql`'s result from `offset`, in `sort`'s order: as many
 * `MAX_ROWS` reads as it takes (an outcome holds at most `MAX_ROWS`). For
 * "Copy all".
 *
 * @throws {Error} like {@link readSlice}.
 */
export async function readRows(
  app: App,
  database: D1StudioResult['database'],
  sql: string,
  { sort, offset, limit }: { sort: Sort; offset: number; limit: number },
  signal?: AbortSignal
): Promise<readonly (readonly D1Cell[])[]> {
  const out: (readonly D1Cell[])[] = []
  for (let at = offset; at < offset + limit; at += MAX_ROWS) {
    const rows = await readSlice(
      app,
      database,
      sql,
      { sort, offset: at, limit: Math.min(MAX_ROWS, offset + limit - at) },
      signal
    )
    out.push(...rows)
    if (rows.length < Math.min(MAX_ROWS, offset + limit - at)) break
  }
  return out
}

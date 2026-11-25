import { z } from 'zod'
import { autoResolvedAccountId, missingAccountMessage } from '../auth/account-access'
import { tools as d1Tools } from '../generated/forge-mcp/d1/tools'
import { ApiReadError, ApiReadUnsupported, apiReader } from '../mcp-apps/api-read'
import { defineMcpApp } from '../mcp-apps/define'
import { appHtml } from './app-html.generated'
import {
  D1StudioInputSchema,
  D1StudioResultSchema,
  D1_STUDIO_RESOURCE_URI,
  D1_STUDIO_TOOL,
  D1_STUDIO_TOOL_CONFIG,
  MODEL_ROWS,
  type D1Query,
  type D1StudioResult
} from './contract'
import { TABLES_SQL, readDatabaseName, runRead, tableNames, withFix } from './read'
import { classifyStatement } from './statement'

/** The generated tool the view re-runs reads with. Its statements are checked in the view, and again here. */
export const D1_RUN_TOOL = 'd1_raw'

/**
 * Why the view's `d1_raw` call may not run: D1's `/raw` has no read-only
 * mode, so in Code Mode the view may send only one statement
 * `classifyStatement` proves is a read, never a `batch`. Writes go to the
 * chat for the agent to run once the user agrees.
 */
export function rawCallRefusal(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool !== D1_RUN_TOOL) return undefined
  const body = args.body
  const sql =
    body && typeof body === 'object' && !Array.isArray(body) && !('batch' in body)
      ? (body as { sql?: unknown }).sql
      : undefined
  if (typeof sql !== 'string')
    return 'D1 Studio runs one read from the view, as `body.sql`; a batch or another body is refused.'
  const statement = classifyStatement(sql)
  if (statement.kind === 'read') return undefined
  return `D1 Studio runs only one read from the view (${statement.kind === 'write' ? statement.keyword : statement.kind}). The agent runs writes with d1_query once the user agrees.`
}

/** Why a query can't run, in words for the model, or undefined when it is one read. */
function refusalOf(label: string, sql: string): string | undefined {
  const statement = classifyStatement(sql)
  switch (statement.kind) {
    case 'read':
      return undefined
    case 'empty':
      return `${label} is empty.`
    case 'multiple':
      return `${label} has more than one statement. d1_studio runs one read per query; pass earlier reads as steps.`
    case 'write':
      return `${label} is not a read (${statement.keyword}). d1_studio only runs reads; use d1_query for writes, after the user agrees.`
  }
}

/**
 * The text the model reads when the view shows the result: each query's
 * outcome with at most {@link MODEL_ROWS} rows, so a 200-row result doesn't
 * fill the context on every later turn.
 */
/**
 * Only hosts that render the view get {@link modelText}, so the user already
 * sees the answer's rows; without this the model tends to repeat them as its
 * own table under the card.
 */
export const SHOWN_NOTE =
  'The user sees these rows in an interactive table above your reply. Answer in a sentence or two from them; do not repeat the rows as a table or list.'

export function modelText(result: D1StudioResult): string {
  const brief = (q: D1Query) => {
    const o = q.outcome
    if (o.status === 'failed') return { title: q.title, sql: q.sql, error: o.error }
    return {
      title: q.title,
      sql: q.sql,
      columns: o.columns,
      rows: o.rows.slice(0, MODEL_ROWS),
      rowCount: o.rowCount,
      ...(o.rowCount > MODEL_ROWS && {
        note: `First ${MODEL_ROWS} of ${o.rowCount} rows; the user sees up to ${o.rows.length} in the view.`
      }),
      meta: o.meta
    }
  }
  return JSON.stringify({
    shown: SHOWN_NOTE,
    database: result.database,
    answer: brief(result.answer),
    ...(result.steps.length && { steps: result.steps.map(brief) })
  })
}

export const d1StudioApp = defineMcpApp({
  name: D1_STUDIO_TOOL,
  ...D1_STUDIO_TOOL_CONFIG,
  input: D1StudioInputSchema,
  output: D1StudioResultSchema,
  resource: { uri: D1_STUDIO_RESOURCE_URI, name: 'D1 Studio', html: appHtml },
  appTools: d1Tools.filter((tool) => tool.name === D1_RUN_TOOL),
  appToolCheck: rawCallRefusal,
  modelText,
  async run(input, context, signal) {
    const accountId = input.account_id ?? autoResolvedAccountId(context.props)
    if (!accountId)
      return { ok: false, text: missingAccountMessage(context.props, 'Use GET /accounts.') }

    const steps = input.steps ?? []
    // Nothing is sent unless every query is one read.
    const refusals = [
      ...steps.map((s, i) => refusalOf(`Step ${i + 1} (${s.title})`, s.sql)),
      input.sql === undefined ? undefined : refusalOf('sql', input.sql)
    ].filter((r): r is string => !!r)
    if (refusals.length) return { ok: false, text: refusals.join('\n') }

    const reader = apiReader(context, signal, 'd1_studio')
    try {
      const run = (sql: string) => runRead(reader, accountId, input.database_id, sql)
      // The name proves the database exists before any query; the listing colours table names.
      const [name, listing] = await Promise.all([
        readDatabaseName(reader, accountId, input.database_id),
        run(TABLES_SQL)
      ])
      // Steps run in order: a later step was written after the agent saw the earlier ones.
      const ran: D1Query[] = []
      for (const step of steps)
        ran.push({
          purpose: 'query',
          title: step.title,
          sql: step.sql,
          ...(step.note && { note: step.note }),
          outcome: await run(step.sql)
        })
      const answer: D1Query =
        input.sql === undefined
          ? {
              purpose: 'tables',
              title: input.title ?? `Tables in ${name}`,
              sql: TABLES_SQL,
              outcome: listing
            }
          : {
              purpose: 'query',
              title: input.title ?? 'Query',
              sql: input.sql,
              outcome: await withFix(
                reader,
                accountId,
                input.database_id,
                input.sql,
                await run(input.sql),
                tableNames(listing)
              )
            }
      return {
        ok: true,
        value: {
          kind: 'd1_studio' as const,
          database: { accountId, id: input.database_id, name },
          tables: tableNames(listing),
          answer,
          steps: ran,
          readAt: Date.now()
        }
      }
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof ApiReadError)
        return { ok: false, text: error.text, meta: error.result._meta }
      if (error instanceof ApiReadUnsupported || error instanceof z.ZodError)
        return { ok: false, text: 'Cloudflare returned an unsupported D1 response.' }
      throw error
    }
  }
})

/**
 * Workers requests by day, for both Workers presets: one GraphQL query over
 * the windows `history.ts` computes.
 */
import { z } from 'zod'
import { ApiReadError, ApiReadUnsupported, type ApiReader } from '../mcp-apps/api-read'
import type { HistoryOutcome } from '../threshold-alert/define'
import type { Day } from '../threshold-alert/model'
import { fillDays, historyWindows, type Window } from './history'

/** Daily Workers requests for each window, as one alias per window in one query. */
function dailyRequestsQuery(windows: readonly Window[]): string {
  const aliases = windows
    .map(
      (_, i) =>
        `      w${i}: workersInvocationsAdaptive(limit: 100, filter: { date_geq: $s${i}, date_leq: $e${i} }, orderBy: [date_ASC]) {
        sum { requests }
        dimensions { date }
      }`
    )
    .join('\n')
  const params = windows.map((_, i) => `$s${i}: Date!, $e${i}: Date!`).join(', ')
  return `query WorkersUsageAlert($account: String!, ${params}) {
  viewer {
    accounts(filter: { accountTag: $account }) {
${aliases}
    }
  }
}`
}

const DailyRows = z.array(
  z.object({
    sum: z.object({ requests: z.number() }),
    dimensions: z.object({ date: z.iso.date() })
  })
)
const DailyRequestsData = z.object({
  viewer: z.object({
    accounts: z.array(z.record(z.string(), DailyRows)).max(1)
  })
})

/**
 * The 89 complete days of Workers requests before `today`, in one GraphQL
 * query. Usage is what the App is about: a refused or failed read is the
 * tool's error.
 */
export async function readWorkersRequests(
  accountId: string,
  today: string,
  reader: ApiReader,
  signal: AbortSignal
): Promise<HistoryOutcome> {
  const windows = historyWindows(today)
  let usage: z.output<typeof DailyRequestsData>
  try {
    usage = await reader.graphql(
      dailyRequestsQuery(windows),
      {
        account: accountId,
        ...Object.fromEntries(
          windows.flatMap((w, i) => [
            [`s${i}`, w.start],
            [`e${i}`, w.end]
          ])
        )
      },
      'account',
      DailyRequestsData
    )
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof ApiReadError)
      return { ok: false, text: error.text, meta: error.result._meta }
    if (error instanceof ApiReadUnsupported || error instanceof z.ZodError)
      return { ok: false, text: 'Cloudflare returned an unsupported analytics response.' }
    throw error
  }
  const account = usage.viewer.accounts[0]
  if (!account)
    return {
      ok: false,
      text: `No Workers analytics were returned for account ${accountId}. Check the account ID and that the connection can read its analytics.`
    }
  // Every window must answer: a missing one would be filled with zeros as days without traffic.
  if (windows.some((_, i) => !Array.isArray(account[`w${i}`])))
    return { ok: false, text: 'Cloudflare returned an unsupported analytics response.' }
  const rows: Day[] = windows.flatMap((_, i) =>
    account[`w${i}`].map((row): Day => [row.dimensions.date, Math.round(row.sum.requests)])
  )
  return { ok: true, days: fillDays(rows, windows) }
}

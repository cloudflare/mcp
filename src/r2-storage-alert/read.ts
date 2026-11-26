/**
 * R2 Standard storage by day, for the R2 storage billing alert: one GraphQL
 * query over the shared windows, summing every bucket's daily peak.
 */
import { z } from 'zod'
import { ApiReadError, ApiReadUnsupported, type ApiReader } from '../mcp-apps/api-read'
import type { HistoryOutcome } from '../threshold-alert/define'
import { fillDays, historyWindows, type Window } from '../threshold-alert/history'
import type { Day } from '../threshold-alert/model'

/** R2 bills storage over a 30-day month: each day's peak counts for 1/30 of it. */
export const BILLING_MONTH_DAYS = 30

/**
 * The most rows one alias returns: 30 days of 66 buckets. Three full aliases
 * stay under the reader's 1 MB cap (`MAX_READ_BYTES`). A full alias may have
 * dropped buckets, which would read as less storage, so the result says so.
 */
export const ALIAS_LIMIT = 2000

/**
 * Each window's daily peak per bucket, as one alias per window. Standard
 * storage only: `r2_storage` is the Standard class; Infrequent Access bills apart.
 * The dataset has no sum across buckets, so rows are days × buckets.
 */
function dailyStorageQuery(windows: readonly Window[]): string {
  const aliases = windows
    .map(
      (_, i) =>
        `      w${i}: r2StorageAdaptiveGroups(limit: ${ALIAS_LIMIT}, filter: { storageClass: "Standard", date_geq: $s${i}, date_leq: $e${i} }, orderBy: [date_ASC]) {
        max { payloadSize metadataSize }
        dimensions { date bucketName }
      }`
    )
    .join('\n')
  const params = windows.map((_, i) => `$s${i}: Date!, $e${i}: Date!`).join(', ')
  return `query R2StorageAlert($account: String!, ${params}) {
  viewer {
    accounts(filter: { accountTag: $account }) {
${aliases}
    }
  }
}`
}

const DailyRows = z.array(
  z.object({
    max: z.object({ payloadSize: z.number(), metadataSize: z.number() }),
    dimensions: z.object({ date: z.iso.date(), bucketName: z.string() })
  })
)
const DailyStorageData = z.object({
  viewer: z.object({
    accounts: z.array(z.record(z.string(), DailyRows)).max(1)
  })
})

/**
 * Yesterday's stored bytes from the history: a day's value is its peak ÷ 30,
 * so this undoes that.
 */
export const storedOn = (days: readonly Day[]) =>
  days.length ? days[days.length - 1][1] * BILLING_MONTH_DAYS : 0

/**
 * The 89 complete days of R2 Standard storage before `today`. Each day is
 * the sum of every bucket's peak that day ÷ 30, in bytes, so a month's total
 * is the average billing counts. A refused or failed read is the tool's error.
 */
export async function readR2Storage(
  accountId: string,
  today: string,
  reader: ApiReader,
  signal: AbortSignal
): Promise<HistoryOutcome> {
  const windows = historyWindows(today)
  let usage: z.output<typeof DailyStorageData>
  try {
    usage = await reader.graphql(
      dailyStorageQuery(windows),
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
      DailyStorageData
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
      text: `No R2 analytics were returned for account ${accountId}. Check the account ID and that the connection can read its analytics.`
    }
  // Every window must answer: a missing one would be filled with zeros as days without data.
  if (windows.some((_, i) => !Array.isArray(account[`w${i}`])))
    return { ok: false, text: 'Cloudflare returned an unsupported analytics response.' }
  const limitations: string[] = []
  if (windows.some((_, i) => account[`w${i}`].length >= ALIAS_LIMIT))
    limitations.push(
      'This account has more buckets than one storage read returns, so some days may count less storage than billing does.'
    )
  const rows: Day[] = windows.flatMap((_, i) =>
    account[`w${i}`].map((row): Day => [
      row.dimensions.date,
      (row.max.payloadSize + row.max.metadataSize) / BILLING_MONTH_DAYS
    ])
  )
  const days = fillDays(rows, windows).map(([date, n]): Day => [date, Math.round(n)])
  return { ok: true, days, limitations }
}

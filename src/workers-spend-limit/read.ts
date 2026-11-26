/**
 * Workers usage charges by day, for the Workers spend policy: the billable
 * usage cost of the Workers product family, which is what a Workers spend
 * policy counts (requests and CPU time, after included usage).
 */
import { z } from 'zod'
import { ApiReadError, ApiReadUnsupported } from '../mcp-apps/api-read'
import type { ApiReader } from '../mcp-apps/api-read'
import type { HistoryOutcome } from '../threshold-alert/define'
import { fillDays, historyWindows } from '../threshold-alert/history'
import type { Day } from '../threshold-alert/model'

/** The read-only billable usage query: `POST`, filtered in the body, at most 31 days a request. */
export const BILLABLE_USAGE_PATH = (accountId: string) => `/accounts/${accountId}/billable/usage`

/**
 * The product family a Workers spend policy covers. Workers AI, KV, R2 and
 * Durable Objects are their own families, and their own policies (or none).
 */
export const WORKERS_FAMILY = 'Workers'

const CostRows = z.object({
  result: z.array(
    z.object({
      ChargePeriodStart: z.iso.datetime({ offset: true }),
      x_ProductFamilyName: z.string().optional(),
      BilledCost: z.number().nullable().optional(),
      BillingCurrency: z.string().nullable().optional()
    })
  )
})

const DAY_MS = 864e5
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * The 89 complete days of Workers usage charges before `today`, in US cents
 * per day: one billable usage query per window (the API takes 31 days), in
 * parallel, `Metric: cost`, `Granularity: DAILY`. A refused or failed read is
 * the tool's error: without charges there is nothing to set a limit against.
 */
export async function readWorkersSpend(
  accountId: string,
  today: string,
  reader: ApiReader,
  signal: AbortSignal
): Promise<HistoryOutcome> {
  const windows = historyWindows(today)
  let answers: Array<z.output<typeof CostRows>>
  try {
    answers = await Promise.all(
      windows.map((w) =>
        reader.query(
          BILLABLE_USAGE_PATH(accountId),
          {
            Metric: 'cost',
            Granularity: 'DAILY',
            // `To` is exclusive: the day after the window's last.
            TimePeriod: {
              From: `${w.start}T00:00:00Z`,
              To: `${isoDay(Date.parse(`${w.end}T00:00:00Z`) + DAY_MS)}T00:00:00Z`
            }
          },
          CostRows
        )
      )
    )
  } catch (error) {
    if (signal.aborted) {
      throw error
    }
    if (error instanceof ApiReadError) {
      return { ok: false, text: error.text, meta: error.result._meta }
    }
    if (error instanceof ApiReadUnsupported || error instanceof z.ZodError) {
      return { ok: false, text: 'Cloudflare returned an unsupported billable usage response.' }
    }
    throw error
  }
  const rows = answers.flatMap((answer) => answer.result)
  const limitations: Array<string> = []
  // Only US dollars are summed, as the API sums them: the policy's threshold is in US cents.
  if (rows.some((row) => row.BillingCurrency && row.BillingCurrency !== 'USD')) {
    limitations.push(
      'Some charges are in a currency other than US dollars and aren’t counted; the spend policy counts US cents.'
    )
  }
  const days: Array<Day> = rows
    .filter((row) => row.x_ProductFamilyName === WORKERS_FAMILY)
    .filter((row) => !row.BillingCurrency || row.BillingCurrency === 'USD')
    .map((row): Day => [row.ChargePeriodStart.slice(0, 10), (row.BilledCost ?? 0) * 100])
  return {
    ok: true,
    days: fillDays(days, windows).map(([date, cents]): Day => [date, Math.round(cents)]),
    limitations
  }
}

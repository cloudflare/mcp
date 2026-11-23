import { z } from 'zod'
import { buildQueries, PERIODS, type DatasetEnv, type PeriodKey, type QueryName } from './queries'

/** What the dashboard needs to reach the Analytics Engine SQL API. */
export interface AnalyticsConfig {
  readonly apiBase: string
  readonly accountId: string
  readonly apiToken: string
}

// The SQL API returns 64-bit integers as strings; every value is a number or text here.
const Cell = z.union([z.string(), z.number(), z.null()])
const SqlResult = z.object({ data: z.array(z.record(z.string(), Cell)) })

export type Row = Record<string, string | number>

export class AnalyticsError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'AnalyticsError'
  }
}

/** Run one read-only query and return its rows, with numeric strings as numbers. */
export async function runQuery(config: AnalyticsConfig, sql: string): Promise<Row[]> {
  const response = await fetch(
    `${config.apiBase}/accounts/${config.accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'text/plain' },
      body: `${sql} FORMAT JSON`
    }
  )
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500)
    throw new AnalyticsError(`Analytics Engine answered ${response.status}: ${detail}`, 502)
  }
  const { data } = SqlResult.parse(await response.json())
  return data.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, numeric(key, value)] as const)
    )
  )
}

/** Columns that hold text even when the text looks like a number. */
const TEXT_COLUMNS = new Set([
  't',
  'tool',
  'harness',
  'protocol',
  'mode',
  'connection',
  'message',
  'product'
])

function numeric(key: string, value: string | number | null): string | number {
  if (value === null) return ''
  if (typeof value === 'number' || TEXT_COLUMNS.has(key)) return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : value
}

export interface Summary {
  readonly env: DatasetEnv
  readonly period: PeriodKey
  readonly periodLabel: string
  readonly generatedAt: string
  readonly panels: Record<QueryName, Row[]>
  /** Panels whose query failed, with why. The others are still returned. */
  readonly errors: Partial<Record<QueryName, string>>
}

/**
 * Every panel for one dataset and period, queried in parallel. A failed panel
 * is reported in `errors` and left empty, so one bad query doesn't blank the page.
 */
export async function summary(
  config: AnalyticsConfig,
  env: DatasetEnv,
  period: PeriodKey,
  now = new Date()
): Promise<Summary> {
  const queries = Object.entries(buildQueries(env, period)) as Array<[QueryName, string]>
  const results = await Promise.allSettled(queries.map(([, sql]) => runQuery(config, sql)))
  const panels = {} as Record<QueryName, Row[]>
  const errors: Partial<Record<QueryName, string>> = {}
  queries.forEach(([name], index) => {
    const result = results[index]
    if (result.status === 'fulfilled') {
      panels[name] = result.value
    } else {
      panels[name] = []
      errors[name] = result.reason instanceof Error ? result.reason.message : String(result.reason)
    }
  })
  return {
    env,
    period,
    periodLabel: PERIODS[period].label,
    generatedAt: now.toISOString(),
    panels,
    errors
  }
}

/**
 * The admin dashboard's Analytics Engine queries, over the `mcp-metrics-*`
 * datasets `src/metrics.ts` writes (its header comment has the layout).
 *
 * Every value put into SQL comes from the allowlists here, never from the
 * request, so no query is built from user input.
 */

export const SERVER_NAME = 'cloudflare-api'

export const DATASETS = {
  production: 'mcp-metrics-production',
  staging: 'mcp-metrics-staging',
  dev: 'mcp-metrics-dev'
} as const

export type DatasetEnv = keyof typeof DATASETS

interface Period {
  readonly label: string
  /** How far back: `INTERVAL '<amount>' <unit>`. */
  readonly window: readonly [amount: number, unit: 'HOUR' | 'DAY']
  /** The width of one point on the time series. */
  readonly bucket: readonly [amount: number, unit: 'HOUR' | 'DAY']
}

/** Analytics Engine keeps three months of data, so 90 days is the longest period. */
export const PERIODS = {
  '24h': { label: 'Last 24 hours', window: [24, 'HOUR'], bucket: [1, 'HOUR'] },
  '7d': { label: 'Last 7 days', window: [7, 'DAY'], bucket: [6, 'HOUR'] },
  '14d': { label: 'Last 14 days', window: [14, 'DAY'], bucket: [12, 'HOUR'] },
  '30d': { label: 'Last 30 days', window: [30, 'DAY'], bucket: [1, 'DAY'] },
  '90d': { label: 'Last 90 days', window: [90, 'DAY'], bucket: [1, 'DAY'] }
} as const satisfies Record<string, Period>

export type PeriodKey = keyof typeof PERIODS

export function isDatasetEnv(value: string | null): value is DatasetEnv {
  return value !== null && Object.hasOwn(DATASETS, value)
}

export function isPeriodKey(value: string | null): value is PeriodKey {
  return value !== null && Object.hasOwn(PERIODS, value)
}

/** Every panel the dashboard draws, one query each. */
export type QueryName =
  | 'toolTimeseries'
  | 'userTimeseries'
  | 'users'
  | 'tools'
  | 'harnesses'
  | 'harnessTools'
  | 'harnessTimeseries'
  | 'breakdown'
  | 'authTimeseries'
  | 'authErrors'
  | 'mismatchTimeseries'
  | 'mismatchProducts'

/**
 * Build every query for one dataset and period.
 *
 * Counts are weighted by Analytics Engine's sampling (`_sample_interval`), and
 * schema mismatches also by our own sample rate (`double4`). Distinct users are
 * counted on the sampled rows, so they are a lower bound, and only user tokens
 * carry a user ID.
 */
export function buildQueries(env: DatasetEnv, periodKey: PeriodKey): Record<QueryName, string> {
  const period: Period = PERIODS[periodKey]
  const dataset = DATASETS[env]
  const since = `timestamp > NOW() - INTERVAL '${period.window[0]}' ${period.window[1]}`
  const bucket = `toStartOfInterval(timestamp, INTERVAL '${period.bucket[0]}' ${period.bucket[1]})`
  const where = (event: string) =>
    `FROM '${dataset}' WHERE index1 = '${event}' AND blob1 = '${SERVER_NAME}' AND ${since}`
  const tools = where('tool_call')
  const calls = 'SUM(_sample_interval) AS calls'
  const errors = 'sumIf(_sample_interval, double1 != 0) AS errors'
  const mismatches = where('response_schema_mismatch')

  return {
    toolTimeseries: `SELECT ${bucket} AS t, ${calls}, ${errors} ${tools} GROUP BY t ORDER BY t ASC`,
    userTimeseries: `SELECT ${bucket} AS t, count(DISTINCT blob3) AS users ${tools} AND blob3 != '' GROUP BY t ORDER BY t ASC`,
    users: `SELECT count(DISTINCT blob3) AS users ${tools} AND blob3 != ''`,
    tools: `SELECT blob4 AS tool, ${calls}, ${errors} ${tools} GROUP BY tool ORDER BY calls DESC LIMIT 200`,
    harnesses: `SELECT blob5 AS harness, ${calls}, ${errors} ${tools} GROUP BY harness ORDER BY calls DESC LIMIT 100`,
    harnessTools: `SELECT blob5 AS harness, blob4 AS tool, ${calls}, ${errors} ${tools} GROUP BY harness, tool ORDER BY calls DESC LIMIT 2000`,
    harnessTimeseries: `SELECT ${bucket} AS t, blob5 AS harness, ${calls} ${tools} GROUP BY t, harness ORDER BY t ASC LIMIT 10000`,
    breakdown: `SELECT blob8 AS protocol, blob9 AS mode, blob10 AS connection, ${calls} ${tools} GROUP BY protocol, mode, connection ORDER BY calls DESC LIMIT 100`,
    authTimeseries: `SELECT ${bucket} AS t, sumIf(_sample_interval, blob4 = '') AS successes, sumIf(_sample_interval, blob4 != '') AS failures ${where('auth_user')} GROUP BY t ORDER BY t ASC`,
    authErrors: `SELECT blob4 AS message, SUM(_sample_interval) AS failures ${where('auth_user')} AND blob4 != '' GROUP BY message ORDER BY failures DESC LIMIT 20`,
    mismatchTimeseries: `SELECT ${bucket} AS t, SUM(_sample_interval * double4) AS responses ${mismatches} GROUP BY t ORDER BY t ASC`,
    mismatchProducts: `SELECT blob7 AS product, SUM(_sample_interval * double4) AS responses, SUM(_sample_interval * double4 * double3) AS violations, count(DISTINCT blob6) AS operations ${mismatches} GROUP BY product ORDER BY responses DESC LIMIT 100`
  }
}

/**
 * Report where Cloudflare API responses don't match their OpenAPI response
 * schemas, grouped by product → operation → violation, from the
 * `response_schema_mismatch` events the direct tools write to Analytics Engine
 * (layout in `src/metrics.ts`). This is the list to send each product team.
 *
 *   npx tsx scripts/schema-mismatch-report.ts [--env production|staging|dev]
 *     [--dataset name] [--days 7] [--product dns_records] [--server cloudflare-api]
 *     [--format markdown|json|sql] [--from-json result.json]
 *
 * Runs one read-only SELECT with the `cf` CLI (`cf analytics_engine sql
 * query`), which needs Account Analytics Read on the account that owns the
 * `mcp-metrics-*` datasets (`scripts/cloudflare-account.ts`). To run the query
 * with another client, such as the Cloudflare MCP server, print it with
 * `--format sql` and render its `FORMAT JSON` result with `--from-json`.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { cfEnv } from './cloudflare-account'
import { z } from 'zod'

/** The repository whose releases publish the OpenAPI document (`SPEC_URL` in `src/spec-release.ts`). */
const SPEC_REPOSITORY = 'cloudflare/forge'

const DATASETS = {
  production: 'mcp-metrics-production',
  staging: 'mcp-metrics-staging',
  dev: 'mcp-metrics-dev'
} as const

const { values: args } = parseArgs({
  options: {
    env: { type: 'string', default: 'production' },
    dataset: { type: 'string' },
    'from-json': { type: 'string' },
    days: { type: 'string', default: '7' },
    product: { type: 'string' },
    server: { type: 'string', default: 'cloudflare-api' },
    format: { type: 'string', default: 'markdown' }
  }
})

const dataset = args.dataset ?? DATASETS[args.env as keyof typeof DATASETS]
if (!dataset) fail(`--env must be one of ${Object.keys(DATASETS).join(', ')}`)
if (!/^[\w.-]+$/.test(dataset)) fail('--dataset must be a plain dataset name')
const days = Number(args.days)
if (!Number.isInteger(days) || days < 1 || days > 90) fail('--days must be a whole number, 1-90')
if (!/^[\w.-]+$/.test(args.server)) fail('--server must be a plain server name')
if (!['markdown', 'json', 'sql'].includes(args.format))
  fail('--format must be markdown, json or sql')

// Counts are weighted by Analytics Engine's sampling and by our own
// RESPONSE_VALIDATION_SAMPLE_RATE (double4 = 1 / rate).
const SQL = `SELECT
  blob7 AS product,
  blob8 AS forge_tool,
  blob5 AS method,
  blob6 AS path,
  blob9 AS response,
  blob10 AS keyword,
  blob11 AS schema_location,
  blob12 AS instance_path,
  blob13 AS spec_release,
  SUM(_sample_interval * double4) AS responses,
  SUM(_sample_interval * double4 * double3) AS violations,
  MIN(double5) AS fully_counted,
  MAX(timestamp) AS last_seen
FROM '${dataset}'
WHERE index1 = 'response_schema_mismatch'
  AND blob1 = '${args.server}'
  AND timestamp > NOW() - INTERVAL '${days}' DAY
GROUP BY product, forge_tool, method, path, response, keyword, schema_location, instance_path, spec_release
ORDER BY product ASC, responses DESC
LIMIT 10000
FORMAT JSON`

if (args.format === 'sql') {
  console.log(SQL)
  process.exit(0)
}

const Row = z.object({
  product: z.string(),
  forge_tool: z.string(),
  method: z.string(),
  path: z.string(),
  response: z.string(),
  keyword: z.string(),
  schema_location: z.string(),
  instance_path: z.string(),
  // Empty when the spec came from a URL that isn't a release download.
  spec_release: z.string().nullable().optional(),
  responses: z.coerce.number(),
  violations: z.coerce.number(),
  fully_counted: z.coerce.number(),
  last_seen: z.string()
})
type Row = z.infer<typeof Row>

const text = args['from-json'] ? readFileSync(args['from-json'], 'utf8') : await runQuery()
const rows = z
  .object({ data: z.array(Row) })
  .parse(JSON.parse(text))
  .data.filter((row) => !args.product || row.product === args.product)
  // Product by name, then the most frequent violations first.
  .sort((a, b) => a.product.localeCompare(b.product) || b.responses - a.responses)

if (args.format === 'json') {
  console.log(JSON.stringify(rows, null, 2))
} else {
  console.log(markdown(rows))
}

/** Run the query with the `cf` CLI and return its `FORMAT JSON` result. */
async function runQuery(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'schema-mismatches-'))
  try {
    const file = join(dir, 'query.sql')
    writeFileSync(file, SQL)
    const { stdout } = await promisify(execFile)(
      'cf',
      ['analytics_engine', 'sql', 'query', '--file', file],
      { env: cfEnv(), maxBuffer: 64 * 1024 * 1024 }
    )
    return stdout
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    return fail(`cf analytics_engine sql query failed${stderr ? `: ${stderr}` : ''}`)
  } finally {
    rmSync(dir, { recursive: true })
  }
}

function markdown(rows: Row[]): string {
  const lines = [
    `# Response schema mismatches`,
    '',
    `\`${dataset}\`, server \`${args.server}\`, last ${days} days. Each row is one way a ` +
      'response broke its OpenAPI schema: the keyword that failed, where it is in the spec, and ' +
      'where in the response (`*` is an array index or a map key). "Responses" counts responses ' +
      'with this as their first violation; "violations" counts every violation in them (`≥` when ' +
      'large responses were only partly checked). "Spec release" links the OpenAPI document the ' +
      'schema location refers to.',
    ''
  ]
  if (rows.length === 0) return [...lines, 'No mismatches recorded.'].join('\n')

  for (const [product, productRows] of groupBy(rows, (row) => row.product)) {
    const total = sum(productRows, (row) => row.responses)
    lines.push(`## ${product}: ${round(total)} responses`, '')

    for (const [operation, operationRows] of groupBy(
      productRows,
      (row) => `${row.method} ${row.path}`
    )) {
      // The generated tool names where its response schema lives in src/generated/forge-mcp.
      const forgeTools = [...new Set(operationRows.map((row) => `\`${row.forge_tool}\``))]
      lines.push(`### \`${operation}\` (${forgeTools.join(', ')})`, '')
      lines.push(
        '| response | keyword | schema location | instance path | spec release | responses | violations | last seen |'
      )
      lines.push('|---|---|---|---|---|---|---|---|')
      for (const row of operationRows) {
        const violations = `${row.fully_counted < 1 ? '≥' : ''}${round(row.violations)}`
        lines.push(
          `| ${row.response} | ${row.keyword} | \`${row.schema_location}\` | \`${row.instance_path}\` | ${release(row.spec_release)} | ${round(row.responses)} | ${violations} | ${row.last_seen} |`
        )
      }
      lines.push('')
    }
  }
  return lines.join('\n')
}

/**
 * A spec release as a link to the document the schema came from, so the
 * schema location can be read as it was when the mismatch was recorded.
 */
function release(tag: string | null | undefined): string {
  if (!tag) return 'unknown'
  const url = `https://github.com/${SPEC_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/openapi.forge.json`
  return `[\`${tag}\`](${url})`
}

/** Group rows, keeping the query's order (busiest first within a product). */
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const group = groups.get(key(item)) ?? []
    group.push(item)
    groups.set(key(item), group)
  }
  return groups
}

function sum<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0)
}

function round(value: number): string {
  return String(Math.round(value))
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

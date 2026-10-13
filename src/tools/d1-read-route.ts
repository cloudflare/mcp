import { z } from 'zod'
import { READ_ONLY_SQL_SUMMARY, classifyD1Sql } from './d1-sql'

/**
 * A read-only D1 query endpoint that only this server provides, for Code
 * Mode. `search` finds it in `spec.json` next to the real query endpoint, and
 * `execute` calls it with `cloudflare.request()` like any other path. The
 * outbound proxy refuses SQL that could write and sends the rest to the real
 * endpoint. The real endpoint accepts a token with only D1 Read, so
 * Cloudflare's permissions don't separate reads from writes on it.
 */
export const D1_READ_QUERY_PATH = '/accounts/{account_id}/d1/database/{database_id}/read_query'

const D1_QUERY_PATH = '/accounts/{account_id}/d1/database/{database_id}/query'

const ROUTE = /^\/accounts\/([^/]+)\/d1\/database\/([^/]+)\/read_query\/?$/i

const D1_READ_QUERY_DESCRIPTION =
  'Provided by this MCP server, not the Cloudflare API. Runs SQL only when every statement is ' +
  `${READ_ONLY_SQL_SUMMARY}, then sends the request unchanged to POST ${D1_QUERY_PATH}. ` +
  'Anything else is refused before it reaches D1. ' +
  `Use POST ${D1_QUERY_PATH} to change data or schema.`

const QuerySchema = z.strictObject({ sql: z.string(), params: z.array(z.unknown()).optional() })

/**
 * The query endpoint's two body forms. Both are strict: a key D1 might act on
 * but this check doesn't read, such as a `batch` next to `sql`, is refused.
 */
const BodySchema = z.union([QuerySchema, z.strictObject({ batch: z.array(QuerySchema).min(1) })])

/**
 * Adds the read-only endpoint to the spec `search` sees. It copies the real
 * query endpoint's parameters, body and responses, and is left out when the
 * spec has no query endpoint. `mcp-tools.json` is built without it, because
 * endpoint tools call the Cloudflare API directly rather than through the
 * outbound proxy.
 *
 * @param paths - The processed spec's paths.
 * @returns The paths with the read-only endpoint added.
 */
export function withD1ReadQueryOperation(
  paths: Record<string, Record<string, unknown>>
): Record<string, Record<string, unknown>> {
  const query = paths[D1_QUERY_PATH]?.post as Record<string, unknown> | undefined
  if (!query) return paths
  return {
    ...paths,
    [D1_READ_QUERY_PATH]: {
      post: {
        ...query,
        summary: 'Query D1 Database (read-only)',
        description: D1_READ_QUERY_DESCRIPTION
      }
    }
  }
}

/**
 * Routes a request from the `execute` isolate that targets the read-only
 * endpoint.
 *
 * @param request - The isolate's outbound request, already checked to be for the API host.
 * @param apiBase - The Cloudflare API base URL, such as `https://api.cloudflare.com/client/v4`.
 * @returns `undefined` for any other path, a refusal for SQL that could write,
 *   or the same request sent to the real query endpoint.
 */
export async function routeD1ReadQuery(
  request: Request,
  apiBase: string
): Promise<Request | Response | undefined> {
  const url = new URL(request.url)
  const basePath = new URL(apiBase).pathname.replace(/\/+$/, '')
  if (!url.pathname.startsWith(`${basePath}/`)) return undefined

  const match = ROUTE.exec(url.pathname.slice(basePath.length))
  if (!match) return undefined

  if (request.method.toUpperCase() !== 'POST') {
    return refusal(405, `${request.method} is not supported. Use POST ${D1_READ_QUERY_PATH}.`)
  }

  const body = await request.text()
  const problem = bodyProblem(body)
  if (problem) return refusal(400, problem)

  const [, accountId, databaseId] = match
  url.pathname = `${basePath}/accounts/${accountId}/d1/database/${databaseId}/query`
  return new Request(url, { method: 'POST', headers: request.headers, body })
}

/** Why the body can't be sent, or `undefined` when every statement only reads. */
function bodyProblem(body: string): string | undefined {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return 'Refused: the body is not JSON. Send { sql, params } or { batch: [{ sql, params }] }.'
  }

  const parsed = BodySchema.safeParse(json)
  if (!parsed.success) {
    return 'Refused: send { sql, params } or { batch: [{ sql, params }] } with no other keys.'
  }

  const queries = 'batch' in parsed.data ? parsed.data.batch : [parsed.data]
  for (const [index, query] of queries.entries()) {
    const verdict = classifyD1Sql(query.sql)
    if (!verdict.readOnly) {
      const which = queries.length > 1 ? `batch[${index}]: ` : ''
      return `Refused: ${which}${verdict.reason} Use POST ${D1_QUERY_PATH} for other SQL.`
    }
  }
  return undefined
}

/** A refusal in the Cloudflare API's error envelope, which `cloudflare.request()` throws as an error. */
function refusal(status: number, message: string): Response {
  return Response.json(
    { success: false, errors: [{ code: status, message }], messages: [], result: null },
    { status }
  )
}

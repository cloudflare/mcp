import { z } from 'zod'
import { env } from 'cloudflare:workers'
import type { CallToolResult, Tool } from '@modelcontextprotocol/server'
import type { FormatToolResult } from '../truncate'
import { fetchWithRetry } from '../utils/fetch-retry'
import {
  NON_CODEMODE_ACCOUNT_DISCOVERY_GUIDANCE,
  autoResolvedAccountId,
  missingAccountMessage,
  unknownAccountHint
} from '../auth/account-access'
import { ACCOUNT_ID_PARAM_DESCRIPTION } from '../openapi'
import type { AuthProps } from '../auth/types'
import { READ_ONLY_SQL_SUMMARY, classifyD1Sql } from './d1-sql'

const NAME = 'd1_read_query'
const TITLE = 'Read-Only D1 Query'

/** The generated endpoint tool that runs any SQL, named for writes. */
const WRITE_TOOL_NAME = 'post_accounts_d1_database_query'

const DESCRIPTION =
  'Run read-only SQL against a D1 database (POST /accounts/{account_id}/d1/database/{database_id}/query). ' +
  `Every statement must be ${READ_ONLY_SQL_SUMMARY}; anything else is refused before it reaches D1. ` +
  `Separate several statements with semicolons. Use ${WRITE_TOOL_NAME} to change data or schema.`

export const D1ReadQueryInputSchema = z.strictObject({
  account_id: z.string().optional().describe(ACCOUNT_ID_PARAM_DESCRIPTION),
  database_id: z.string().describe('D1 database ID (UUID).'),
  sql: z.string().describe('The SQL to run. Use ? placeholders for values.'),
  params: z.array(z.string()).optional().describe('Values bound to the ? placeholders, in order.')
})

type D1ReadQueryInput = z.infer<typeof D1ReadQueryInputSchema>

/**
 * Wire definition served by the non-Code-Mode `tools/list`. The hints let a
 * client approve this tool on its own, which is why the SQL is checked
 * before the call rather than trusted.
 */
export const D1_READ_QUERY_TOOL: Tool = {
  name: NAME,
  title: TITLE,
  description: DESCRIPTION,
  inputSchema: z.toJSONSchema(D1ReadQueryInputSchema) as Tool['inputSchema'],
  annotations: {
    title: TITLE,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
}

/**
 * Run `d1_read_query`: refuse SQL that could write, then send the rest to D1's
 * query endpoint. The endpoint accepts a token with only D1 Read, so
 * Cloudflare's permissions don't separate reads from writes on it; this check
 * is what makes the tool read-only.
 *
 * @param input - The validated tool arguments.
 * @param props - The request's validated credential.
 * @param formatResult - Turns the API response body into the tool's text output.
 */
export async function runD1ReadQuery(
  input: D1ReadQueryInput,
  props: AuthProps,
  formatResult: FormatToolResult
): Promise<CallToolResult> {
  const verdict = classifyD1Sql(input.sql)
  if (!verdict.readOnly) {
    return toolError(`Refused: ${verdict.reason} Use ${WRITE_TOOL_NAME} for other SQL.`)
  }

  const accountId = input.account_id || autoResolvedAccountId(props)
  if (!accountId) {
    return toolError(missingAccountMessage(props, NON_CODEMODE_ACCOUNT_DISCOVERY_GUIDANCE))
  }

  const path = `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(input.database_id)}/query`
  const response = await fetchWithRetry(
    env.CLOUDFLARE_API_BASE + path,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${props.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ sql: input.sql, ...(input.params && { params: input.params }) })
    },
    { caller: 'd1_read_query' }
  )
  const contentType = response.headers.get('content-type') || ''
  const result = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  const hint = !response.ok && input.account_id ? unknownAccountHint(props, input.account_id) : ''
  return {
    content: [{ type: 'text', text: formatResult(result) + (hint ? `\n\n${hint}` : '') }],
    isError: !response.ok
  }
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

import { z } from 'zod'
import { env } from 'cloudflare:workers'
import type { CallToolResult, McpServer, Tool } from '@modelcontextprotocol/server'
import { autoResolvedAccountId } from '../auth/account-access'
import type { AuthProps } from '../auth/types'
import type { Connection } from '../api-permissions'
import { graphqlRefusalFor } from '../api-refusals'
import { withCachedJsonSchema } from '../lib/isolate-json-schema'
import { rateLimitHint } from '../rate-limit'
import { WWW_AUTHENTICATE_META_KEY, type ScopeChallenge } from '../scope-challenge'
import type { FormatToolResult } from '../truncate'
import { formatError } from '../utils/errors'
import { fetchWithRetry } from '../utils/fetch-retry'
import { apiCallResult } from './api-call-result'
import { bodyValue, readResponse } from './response-body'

const TITLE = 'Cloudflare GraphQL Analytics'

const DESCRIPTION =
  "Run a query against Cloudflare's GraphQL Analytics API. Only queries run: a mutation or subscription is refused. " +
  'Pass the whole document as `query` and its `variables`. ' +
  "If the query declares `$accountTag` and `variables` has no `accountTag`, it defaults to the connection's account when there is exactly one. " +
  'Account example: `query ($accountTag: string!) { viewer { accounts(filter: { accountTag: $accountTag }) { … } } }`. ' +
  'Zone example: `query ($zoneTag: string!) { viewer { zones(filter: { zoneTag: $zoneTag }) { … } } }`. ' +
  'Query `__type(name: "…")` to list the fields of a dataset.'

const QUERY_DESCRIPTION = 'A whole GraphQL query document.'
const VARIABLES_DESCRIPTION = 'Values for the variables the query declares.'

/** Arguments. Strict: unknown keys are refused, as in the generated tools. */
export const GraphqlAnalyticsInputSchema = withCachedJsonSchema(
  z.strictObject({
    query: z.string().min(1).describe(QUERY_DESCRIPTION),
    variables: z.record(z.string(), z.unknown()).optional().describe(VARIABLES_DESCRIPTION)
  })
)

type GraphqlAnalyticsArguments = z.infer<typeof GraphqlAnalyticsInputSchema>

const ANNOTATIONS = {
  title: TITLE,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true
}

/**
 * Wire definition served by the non-Code-Mode `tools/list`. It is the same for
 * every session. Tests keep it identical to what the SDK emits for
 * {@link registerGraphqlAnalyticsTool}.
 */
export const GRAPHQL_ANALYTICS_TOOL: Tool = {
  name: 'graphql_analytics',
  title: TITLE,
  description: DESCRIPTION,
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, description: QUERY_DESCRIPTION },
      variables: {
        type: 'object',
        propertyNames: { type: 'string' },
        additionalProperties: {},
        description: VARIABLES_DESCRIPTION
      }
    },
    required: ['query'],
    additionalProperties: false
  },
  annotations: ANNOTATIONS
}

/** Under the TypeScript SDK's 60-second request timeout, so the client gets this tool's error, not its own. */
const GRAPHQL_TIMEOUT_MS = 50_000

/** What the API answers a query with. Errors and data are read; the rest is returned as sent. */
const GraphqlAnswer = z.looseObject({
  data: z.unknown().optional(),
  errors: z.array(z.looseObject({ message: z.unknown().optional() })).optional()
})

/**
 * The first operation keyword of each definition at the document's top level,
 * found with a scanner rather than a GraphQL parser. Comments, strings and
 * block strings are skipped, and nothing inside `{}`, `()` or `[]` counts, so a
 * field, argument, fragment or operation named `mutation` is not one.
 */
function operationKeywords(document: string): string[] {
  const keywords: string[] = []
  let depth = 0
  let atDefinitionStart = true
  let i = 0
  while (i < document.length) {
    const char = document[i]
    if (char === '#') {
      while (i < document.length && document[i] !== '\n' && document[i] !== '\r') i++
    } else if (document.startsWith('"""', i)) {
      i += 3
      while (i < document.length && !document.startsWith('"""', i)) {
        i += document.startsWith('\\"""', i) ? 4 : 1
      }
      i += 3
    } else if (char === '"') {
      i++
      while (i < document.length && document[i] !== '"' && document[i] !== '\n') {
        i += document[i] === '\\' ? 2 : 1
      }
      i++
    } else if (char === '{' || char === '(' || char === '[') {
      depth++
      atDefinitionStart = false
      i++
    } else if (char === '}' || char === ')' || char === ']') {
      depth = Math.max(0, depth - 1)
      if (depth === 0 && char === '}') atDefinitionStart = true
      i++
    } else if (/[_A-Za-z]/.test(char)) {
      let end = i + 1
      while (end < document.length && /[_0-9A-Za-z]/.test(document[end])) end++
      if (depth === 0 && atDefinitionStart) {
        keywords.push(document.slice(i, end))
        atDefinitionStart = false
      }
      i = end
    } else {
      i++
    }
  }
  return keywords
}

/** The operation type that makes a document something other than a query, if any. */
function nonQueryOperation(document: string): string | undefined {
  return operationKeywords(document).find(
    (keyword) => keyword === 'mutation' || keyword === 'subscription'
  )
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/**
 * Run one GraphQL Analytics query.
 *
 * The host sends the request itself, with the session's token, which never
 * enters an isolate. Only queries are sent. A missing analytics permission
 * comes back from the API as `200` with `data: null`, so it is read from the
 * error messages (`graphqlRefusalFor`) and explained, and asks for a step-up
 * when a missing OAuth scope would let the query through. One read request
 * changed nothing, so the client can retry the call after stepping up.
 *
 * @param args - The query document and its variables.
 * @param context - The credential, its connection, and the request's step-up challenge and formatter.
 * @returns The response as text, or a tool error.
 */
export async function runGraphqlAnalyticsTool(
  args: GraphqlAnalyticsArguments,
  {
    props,
    connection,
    scopeChallenge,
    formatResult
  }: {
    props: AuthProps
    connection: Connection
    scopeChallenge: ScopeChallenge
    formatResult: FormatToolResult
  }
): Promise<CallToolResult> {
  const operation = nonQueryOperation(args.query)
  if (operation) {
    return toolError(
      `graphql_analytics runs queries only; this document is a ${operation}. Nothing was sent.`
    )
  }

  const sessionAccountId = autoResolvedAccountId(props)
  const variables =
    sessionAccountId &&
    args.variables?.accountTag === undefined &&
    /\$accountTag\b/.test(args.query)
      ? { ...args.variables, accountTag: sessionAccountId }
      : args.variables

  let response: Response
  try {
    response = await fetchWithRetry(
      `${env.CLOUDFLARE_API_BASE}/graphql`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${props.accessToken}`
        },
        body: JSON.stringify({ query: args.query, variables }),
        signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS)
      },
      { caller: 'graphql_analytics_tool_call' }
    )
  } catch (error) {
    if (!isTimeout(error)) throw error
    return toolError(
      `The query took longer than ${GRAPHQL_TIMEOUT_MS / 1000} seconds. Narrow its time range or lower its \`limit\`.`
    )
  }

  const rateLimit = rateLimitHint(response.status, response.headers)
  const body = await readResponse(response)
  const value = bodyValue(body)

  const answer = body.kind === 'json' ? GraphqlAnswer.safeParse(value) : undefined
  if (!answer?.success || response.status < 200 || response.status >= 300) {
    // Not a GraphQL answer: a refusal or failure of the request itself, read like the other direct tools.
    return apiCallResult(
      {
        method: 'POST',
        path: '/graphql',
        template: '/graphql',
        permissions: undefined,
        status: response.status,
        body: value
      },
      [rateLimit].filter((note) => note !== undefined),
      { connection, scopeChallenge, formatResult }
    )
  }

  const { data, errors } = answer.data
  if (!errors?.length || (data !== null && data !== undefined)) {
    return { content: [{ type: 'text', text: formatResult(value) }] }
  }

  const messages = errors.flatMap(({ message }) => (typeof message === 'string' ? [message] : []))
  const refusal = graphqlRefusalFor(connection, messages)
  const text = [
    `GraphQL error: ${messages.join(', ') || 'the API returned no message'}`,
    formatResult(value),
    refusal?.hint
  ]
    .filter(Boolean)
    .join('\n\n')
  const failure = toolError(text)
  const challenge = refusal?.scope ? scopeChallenge.require(refusal.scope) : undefined
  return challenge ? { ...failure, _meta: { [WWW_AUTHENTICATE_META_KEY]: [challenge] } } : failure
}

/**
 * Register `graphql_analytics` on a Code Mode server.
 *
 * @param server - The per-request MCP server.
 * @param props - The request's validated credential.
 * @param formatResult - Renders the response for the client.
 * @param connection - What the request's token is allowed to do.
 * @param scopeChallenge - Where the tool records a scope it needs, for a step-up.
 */
export function registerGraphqlAnalyticsTool(
  server: McpServer,
  props: AuthProps,
  formatResult: FormatToolResult,
  connection: Connection,
  scopeChallenge: ScopeChallenge
): void {
  server.registerTool(
    GRAPHQL_ANALYTICS_TOOL.name,
    {
      title: TITLE,
      description: DESCRIPTION,
      inputSchema: GraphqlAnalyticsInputSchema,
      annotations: { ...ANNOTATIONS }
    },
    async (args) => {
      try {
        return await runGraphqlAnalyticsTool(args, {
          props,
          connection,
          scopeChallenge,
          formatResult
        })
      } catch (error) {
        return formatError(error)
      }
    }
  )
}

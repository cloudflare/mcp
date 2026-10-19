import { z } from 'zod'
import { env } from 'cloudflare:workers'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import { buildRequest, InvalidArguments, type CatalogueTool } from '@cloudflare/forge-mcp'
import type { FormatToolResult } from '../truncate'
import { fetchWithRetry } from '../utils/fetch-retry'
import { getForgeTools } from '../isolate-cache'
import {
  autoResolvedAccountId,
  missingAccountMessage,
  unknownAccountHint
} from '../auth/account-access'
import { recordToolCall } from '../metrics'
import { DOCS_TOOL, runDocsTool } from './docs-search'
import { WHOAMI_TOOL, WhoamiInputSchema, runWhoamiTool } from './whoami'
import type { AuthProps } from '../auth/types'
import type { Connection } from '../api-permissions'
import { explainRefusalFor } from '../api-refusal-hint'
import { WWW_AUTHENTICATE_META_KEY, type ScopeChallenge } from '../scope-challenge'
import { FORGE_ACCOUNT_DISCOVERY_GUIDANCE, PERMISSIONS_EXTENSION } from '../forge-tools/policy'

const ACCOUNT_OR_ZONE_PREFIX = '/{account_or_zone}/{account_or_zone_id}'

/**
 * Serve the forge-mcp catalogue (`?forge=true`): the direct tools the
 * Cloudflare forge plugin generated from `openapi.forge.json`, alongside
 * `docs` and `whoami`.
 *
 * `tools/list` returns the cached catalogue as generated. `tools/call` fills in
 * the session's account, builds the request with forge-mcp, and sends it with
 * the session's token. A refused call is explained, and asks for a step-up when
 * a missing OAuth scope would let it through, as the other direct tools do.
 */
export async function registerForgeTools(
  server: McpServer,
  props: AuthProps,
  formatResult: FormatToolResult,
  connection: Connection,
  scopeChallenge: ScopeChallenge
): Promise<void> {
  const tools = await getForgeTools()

  server.server.setRequestHandler('tools/list', () => ({
    tools: [DOCS_TOOL, WHOAMI_TOOL, ...tools.list]
  }))

  server.server.setRequestHandler('tools/call', async (request) => {
    const name = request.params.name
    const args = request.params.arguments ?? {}
    let result: CallToolResult

    try {
      if (name === DOCS_TOOL.name) {
        const parsed = z.object({ query: z.string() }).safeParse(args)
        result = parsed.success
          ? await runDocsTool(parsed.data.query)
          : toolError(`Invalid arguments for tool ${name}: ${parsed.error.message}`)
      } else if (name === WHOAMI_TOOL.name) {
        const parsed = WhoamiInputSchema.safeParse(args)
        result = parsed.success
          ? runWhoamiTool(props)
          : toolError(`Invalid arguments for tool ${name}: ${parsed.error.message}`)
      } else {
        const tool = tools.byName.get(name)
        result = tool
          ? await callForgeTool(tool, args, props, formatResult, { connection, scopeChallenge })
          : toolError(`Tool ${name} not found`)
      }
    } catch (error) {
      result = toolError(error instanceof Error ? error.message : String(error))
    }

    recordToolCall(props, name, result.isError === true)
    return result
  })
}

async function callForgeTool(
  tool: CatalogueTool,
  given: Record<string, unknown>,
  props: AuthProps,
  formatResult: FormatToolResult,
  { connection, scopeChallenge }: { connection: Connection; scopeChallenge: ScopeChallenge }
): Promise<CallToolResult> {
  const args = withSessionAccount(tool, given, props)
  if (typeof args === 'string') return toolError(args)

  let request: Request
  try {
    request = buildRequest(tool, args, env.CLOUDFLARE_API_BASE)
  } catch (error) {
    if (error instanceof InvalidArguments) return toolError(error.message)
    throw error
  }
  const headers = Object.fromEntries(request.headers)
  headers['authorization'] = `Bearer ${props.accessToken}`
  const body =
    tool.request.body && args[tool.request.body.key] !== undefined
      ? await request.text()
      : undefined

  const response = await fetchWithRetry(
    request.url,
    { method: request.method, headers, body },
    { caller: 'forge_tool_call' }
  )
  const contentType = response.headers.get('content-type') || ''
  const result = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  if (response.ok) return { content: [{ type: 'text', text: formatResult(result) }] }

  const method = request.method
  const refusal = explainRefusalFor(response.status, connection, method, template(tool, args), {
    'x-api-token-group': tool.extensions?.[PERMISSIONS_EXTENSION]
  })
  const accountId = accountIdOf(args)
  const notes = [refusal?.hint, accountId ? unknownAccountHint(props, accountId) : ''].filter(
    Boolean
  )
  const path = new URL(request.url).pathname.slice(new URL(env.CLOUDFLARE_API_BASE).pathname.length)
  const text = [
    `Cloudflare API error: ${method} ${path} returned HTTP ${response.status}.`,
    formatResult(result),
    ...notes
  ].join('\n\n')
  const failure: CallToolResult = { content: [{ type: 'text', text }], isError: true }
  // One refused request changed nothing, so the client can retry the call after stepping up.
  const challenge = refusal?.scope ? scopeChallenge.require(refusal.scope) : undefined
  return challenge ? { ...failure, _meta: { [WWW_AUTHENTICATE_META_KEY]: [challenge] } } : failure
}

/**
 * The arguments with the session's account filled in where the tool takes an
 * account and the caller left it out, or a message saying which account to pick.
 */
function withSessionAccount(
  tool: CatalogueTool,
  args: Record<string, unknown>,
  props: AuthProps
): Record<string, unknown> | string {
  const pathKeys = new Set(tool.request.params.filter((p) => p.in === 'path').map((p) => p.key))
  const key = pathKeys.has('account_id')
    ? 'account_id'
    : pathKeys.has('account_or_zone_id') && args.account_or_zone === 'accounts'
      ? 'account_or_zone_id'
      : undefined
  if (!key || args[key] !== undefined) return args

  const accountId = autoResolvedAccountId(props)
  return accountId
    ? { ...args, [key]: accountId }
    : missingAccountMessage(props, FORGE_ACCOUNT_DISCOVERY_GUIDANCE)
}

function accountIdOf(args: Record<string, unknown>): string | undefined {
  const id = args.account_or_zone === 'accounts' ? args.account_or_zone_id : args.account_id
  return typeof id === 'string' ? id : undefined
}

/** The endpoint's path template, with a merged account-or-zone path made concrete. */
function template(tool: CatalogueTool, args: Record<string, unknown>): string {
  const path = tool.request.path
  if (!path.startsWith(ACCOUNT_OR_ZONE_PREFIX)) return path
  const scope = args.account_or_zone === 'zones' ? '/zones/{zone_id}' : '/accounts/{account_id}'
  return scope + path.slice(ACCOUNT_OR_ZONE_PREFIX.length)
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

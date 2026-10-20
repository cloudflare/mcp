import { z } from 'zod'
import { env } from 'cloudflare:workers'
import type { McpServer, CallToolResult, Tool as McpTool } from '@modelcontextprotocol/server'
import type { Args, Tool } from '../generated/forge-mcp'
import type { FormatToolResult } from '../truncate'
import { fetchWithRetry } from '../utils/fetch-retry'
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
import { cloudflareTool, permissionsOf } from '../forge-tools/cloudflare'
import { FORGE_ACCOUNT_DISCOVERY_GUIDANCE, PERMISSIONS_EXTENSION } from '../forge-tools/policy'

const ACCOUNT_OR_ZONE_PREFIX = '/{account_or_zone}/{account_or_zone_id}'

/** The generated tools with the Cloudflare policy applied, and what calls them. */
interface ForgeTools {
  /** `docs`, `whoami`, then every generated tool, as `tools/list` sends them. */
  readonly list: readonly McpTool[]
  readonly byName: ReadonlyMap<string, Tool>
  readonly buildRequest: (tool: Tool, args: Args, baseUrl: string) => Request
  readonly isInvalidArguments: (error: unknown) => boolean
}

let loading: Promise<ForgeTools> | undefined

/**
 * Loads the generated server (`src/generated/forge-mcp`) the first time an
 * isolate serves `?forge=true`, and keeps it. It is imported lazily so that
 * isolates serving Code Mode never evaluate its ~3,000 tools.
 */
export function loadForgeTools(): Promise<ForgeTools> {
  loading ??= import('../generated/forge-mcp').then((generated) => {
    const tools = generated.tools.map(cloudflareTool)
    return {
      list: [DOCS_TOOL, WHOAMI_TOOL, ...generated.listTools(tools)],
      byName: generated.toolsByName(tools),
      buildRequest: generated.buildRequest,
      isInvalidArguments: (error) => error instanceof generated.InvalidArguments
    }
  })
  loading.catch(() => {
    loading = undefined
  })
  return loading
}

/**
 * Serve the direct tools forge generates from `openapi.forge.json`
 * (`?forge=true`), alongside `docs` and `whoami`.
 *
 * `tools/list` returns the generated tools, built once per isolate.
 * `tools/call` fills in the session's account, builds the request with the
 * tool's generated code, and sends it with the session's token. A refused call
 * is explained, and asks for a step-up when a missing OAuth scope would let it
 * through, as the other direct tools do.
 */
export async function registerForgeTools(
  server: McpServer,
  props: AuthProps,
  formatResult: FormatToolResult,
  connection: Connection,
  scopeChallenge: ScopeChallenge
): Promise<void> {
  const tools = await loadForgeTools()

  // The SDK types the list as mutable; it only serializes it.
  server.server.setRequestHandler('tools/list', () => ({ tools: tools.list as McpTool[] }))

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
          ? await callForgeTool(tools, tool, args, props, formatResult, {
              connection,
              scopeChallenge
            })
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
  tools: ForgeTools,
  tool: Tool,
  given: Args,
  props: AuthProps,
  formatResult: FormatToolResult,
  { connection, scopeChallenge }: { connection: Connection; scopeChallenge: ScopeChallenge }
): Promise<CallToolResult> {
  const args = withSessionAccount(tool, given, props)
  if (typeof args === 'string') return toolError(args)

  let request: Request
  try {
    request = tools.buildRequest(tool, args, env.CLOUDFLARE_API_BASE)
  } catch (error) {
    if (tools.isInvalidArguments(error)) return toolError((error as Error).message)
    throw error
  }
  const headers = Object.fromEntries(request.headers)
  headers['authorization'] = `Bearer ${props.accessToken}`
  const body = request.body ? await request.text() : undefined

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
    [PERMISSIONS_EXTENSION]: permissionsOf(tool)
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
function withSessionAccount(tool: Tool, args: Args, props: AuthProps): Args | string {
  const key = tool.path.includes('{account_id}')
    ? 'account_id'
    : tool.path.startsWith(ACCOUNT_OR_ZONE_PREFIX) && args.account_or_zone === 'accounts'
      ? 'account_or_zone_id'
      : undefined
  if (!key || args[key] !== undefined) return args

  const accountId = autoResolvedAccountId(props)
  return accountId
    ? { ...args, [key]: accountId }
    : missingAccountMessage(props, FORGE_ACCOUNT_DISCOVERY_GUIDANCE)
}

function accountIdOf(args: Args): string | undefined {
  const id = args.account_or_zone === 'accounts' ? args.account_or_zone_id : args.account_id
  return typeof id === 'string' ? id : undefined
}

/** The endpoint's path template, with a merged account-or-zone path made concrete. */
function template(tool: Tool, args: Args): string {
  if (!tool.path.startsWith(ACCOUNT_OR_ZONE_PREFIX)) return tool.path
  const scope = args.account_or_zone === 'zones' ? '/zones/{zone_id}' : '/accounts/{account_id}'
  return scope + tool.path.slice(ACCOUNT_OR_ZONE_PREFIX.length)
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

import { z } from 'zod'
import { env } from 'cloudflare:workers'
import { PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server'
import type { McpServer, CallToolResult, ServerContext } from '@modelcontextprotocol/server'
import type { FormatToolResult } from '../truncate'
import { fetchWithRetry } from '../utils/fetch-retry'
import { getForgeToolList } from '../isolate-cache'
import {
  autoResolvedAccountId,
  missingAccountMessage,
  unknownAccountHint
} from '../auth/account-access'
import { recordToolCall } from '../metrics'
import { checkResponse } from '../response-validation'
import { DOCS_TOOL, runDocsTool } from './docs-search'
import { WHOAMI_TOOL, WhoamiInputSchema, runWhoamiTool } from './whoami'
import type { AuthProps } from '../auth/types'
import { isRefusal, type Connection } from '../api-permissions'
import { findEndpoint, isEmptyList } from '../api-refusals'
import { apiCallResult } from './api-call-result'
import type { ScopeChallenge } from '../scope-challenge'
import type { CallPlan } from '../forge-tools/plan'
import { FORGE_ACCOUNT_DISCOVERY_GUIDANCE } from '../forge-tools/policy'

/** The forge tools service, which holds the generated tools (`src/forge-tools/worker.ts`). */
function forgeTools() {
  return env.FORGE_TOOLS
}

/**
 * Serve the direct tools forge generates from `openapi.forge.json`
 * (`?codemode=false&experimentalForge=true`), alongside `docs` and `whoami`.
 *
 * The generated tools live in the forge tools service, a Worker of their own,
 * so that isolates serving Code Mode never compile them. `tools/list` asks it
 * for the tools; `tools/call` asks it for the request a call makes, then sends
 * that request with the session's token, which never leaves this Worker. A
 * refused call is explained, and asks for a step-up when a missing OAuth scope
 * would let it through, as the other direct tools do.
 *
 * With `outputSchema` (`&experimentalOutputSchema=true`), a 2026-07-28 request
 * lists each tool with its generated output schema, and a successful call
 * returns the whole response body as `structuredContent`, never truncated.
 */
export function registerForgeTools(
  server: McpServer,
  props: AuthProps,
  formatResult: FormatToolResult,
  connection: Connection,
  scopeChallenge: ScopeChallenge,
  { outputSchema = false }: { outputSchema?: boolean } = {}
): void {
  server.server.setRequestHandler('tools/list', async (_request, ctx) => ({
    tools: [
      DOCS_TOOL,
      WHOAMI_TOOL,
      ...(await getForgeToolList({ outputSchema: outputSchema && isModern(ctx) }))
    ]
  }))

  server.server.setRequestHandler('tools/call', async (request, ctx) => {
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
        const sessionAccountId = autoResolvedAccountId(props)
        const plan = (await forgeTools().plan(name, args, {
          baseUrl: env.CLOUDFLARE_API_BASE,
          ...(sessionAccountId && { sessionAccountId })
        })) as CallPlan
        result = await callForgeTool(name, plan, props, formatResult, {
          connection,
          scopeChallenge,
          structured: outputSchema && isModern(ctx)
        })
      }
    } catch (error) {
      result = toolError(error instanceof Error ? error.message : String(error))
    }

    recordToolCall(props, name, result.isError === true)
    return result
  })
}

async function callForgeTool(
  name: string,
  plan: CallPlan,
  props: AuthProps,
  formatResult: FormatToolResult,
  {
    connection,
    scopeChallenge,
    structured
  }: { connection: Connection; scopeChallenge: ScopeChallenge; structured: boolean }
): Promise<CallToolResult> {
  switch (plan.kind) {
    case 'unknown':
      return toolError(`Tool ${name} not found`)
    case 'invalid':
      return toolError(plan.message)
    case 'needs_account':
      return toolError(missingAccountMessage(props, FORGE_ACCOUNT_DISCOVERY_GUIDANCE))
    case 'request':
      break
  }

  const response = await fetchWithRetry(
    plan.url,
    {
      method: plan.method,
      headers: { ...plan.headers, authorization: `Bearer ${props.accessToken}` },
      body: plan.body
    },
    { caller: 'forge_tool_call' }
  )
  const json = isJson(response)
  const bodyText = await response.text()
  const result: unknown = json ? JSON.parse(bodyText) : bodyText

  // Background check against the spec's response schema; never affects the result.
  if (json) {
    checkResponse({
      toolName: name,
      method: plan.method,
      pathTemplate: plan.template,
      status: response.status,
      body: result,
      bodyChars: bodyText.length,
      props
    })
  }

  // What the endpoint accepts only matters when Cloudflare may have refused the call.
  const path = new URL(plan.url).pathname.slice(new URL(env.CLOUDFLARE_API_BASE).pathname.length)
  const endpoint =
    isRefusal(response.status) || isEmptyList(result)
      ? await findEndpoint(plan.method, path).catch(() => undefined)
      : undefined
  const toolResult = apiCallResult(
    {
      method: plan.method,
      path,
      template: plan.template,
      access: endpoint?.access,
      status: response.status,
      body: result
    },
    plan.accountId ? [unknownAccountHint(props, plan.accountId)] : [],
    { connection, scopeChallenge, formatResult }
  )
  return structured && json && !toolResult.isError
    ? { ...toolResult, structuredContent: result }
    : toolResult
}

/**
 * Whether the request is protocol 2026-07-28 or later. Only those carry the
 * per-request `_meta` envelope, which names the protocol version.
 */
function isModern(ctx: ServerContext): boolean {
  const envelope: Record<string, unknown> | undefined = ctx.mcpReq.envelope
  return typeof envelope?.[PROTOCOL_VERSION_META_KEY] === 'string'
}

/** Whether `response` is JSON, including `+json` types such as `application/scim+json`. */
function isJson(response: Response): boolean {
  const type = (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase()
  return type === 'application/json' || type.endsWith('+json')
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

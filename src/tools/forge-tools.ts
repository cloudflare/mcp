import { z } from 'zod'
import { env } from 'cloudflare:workers'
import type { McpServer, CallToolResult, Tool as McpTool } from '@modelcontextprotocol/server'
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
import type { CallPlan } from '../forge-tools/plan'
import { FORGE_ACCOUNT_DISCOVERY_GUIDANCE, PERMISSIONS_EXTENSION } from '../forge-tools/policy'

/** The forge tools service, which holds the generated tools (`src/forge-tools/worker.ts`). */
function forgeTools() {
  return env.FORGE_TOOLS
}

/**
 * Serve the direct tools forge generates from `openapi.forge.json`
 * (`?forge=true`), alongside `docs` and `whoami`.
 *
 * The generated tools live in the forge tools service, a Worker of their own,
 * so that isolates serving Code Mode never compile them. `tools/list` asks it
 * for the tools; `tools/call` asks it for the request a call makes, then sends
 * that request with the session's token, which never leaves this Worker. A
 * refused call is explained, and asks for a step-up when a missing OAuth scope
 * would let it through, as the other direct tools do.
 */
export function registerForgeTools(
  server: McpServer,
  props: AuthProps,
  formatResult: FormatToolResult,
  connection: Connection,
  scopeChallenge: ScopeChallenge
): void {
  server.server.setRequestHandler('tools/list', async () => {
    const generated = (await forgeTools().list()) as McpTool[]
    return { tools: [DOCS_TOOL, WHOAMI_TOOL, ...generated] }
  })

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
        const sessionAccountId = autoResolvedAccountId(props)
        const plan = (await forgeTools().plan(name, args, {
          baseUrl: env.CLOUDFLARE_API_BASE,
          ...(sessionAccountId && { sessionAccountId })
        })) as CallPlan
        result = await callForgeTool(name, plan, props, formatResult, {
          connection,
          scopeChallenge
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
  { connection, scopeChallenge }: { connection: Connection; scopeChallenge: ScopeChallenge }
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
  const contentType = response.headers.get('content-type') || ''
  const result = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  if (response.ok) return { content: [{ type: 'text', text: formatResult(result) }] }

  const refusal = explainRefusalFor(response.status, connection, plan.method, plan.template, {
    [PERMISSIONS_EXTENSION]: plan.permissions
  })
  const notes = [
    refusal?.hint,
    plan.accountId ? unknownAccountHint(props, plan.accountId) : ''
  ].filter(Boolean)
  const path = new URL(plan.url).pathname.slice(new URL(env.CLOUDFLARE_API_BASE).pathname.length)
  const text = [
    `Cloudflare API error: ${plan.method} ${path} returned HTTP ${response.status}.`,
    formatResult(result),
    ...notes
  ].join('\n\n')
  const failure: CallToolResult = { content: [{ type: 'text', text }], isError: true }
  // One refused request changed nothing, so the client can retry the call after stepping up.
  const challenge = refusal?.scope ? scopeChallenge.require(refusal.scope) : undefined
  return challenge ? { ...failure, _meta: { [WWW_AUTHENTICATE_META_KEY]: [challenge] } } : failure
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

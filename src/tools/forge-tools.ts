import { z } from 'zod'
import { env } from 'cloudflare:workers'
import { PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server'
import type {
  McpServer,
  CallToolResult,
  InputRequiredResult,
  ServerContext
} from '@modelcontextprotocol/server'
import type { FormatToolResult } from '../truncate'
import { fetchWithRetry } from '../utils/fetch-retry'
import { rateLimitHint } from '../rate-limit'
import { getForgeToolList } from '../isolate-cache'
import {
  autoResolvedAccountId,
  missingAccountMessage,
  unknownAccountHint
} from '../auth/account-access'
import { recordToolCall, toolCallClient, type RequestClient } from '../metrics'
import { checkResponse } from '../response-validation'
import { DOCS_TOOL, runDocsTool } from './docs-search'
import { WHOAMI_TOOL, WhoamiInputSchema, runWhoamiTool } from './whoami'
import { SUBMIT_FEEDBACK_TOOL, feedbackTools, runSubmitFeedbackTool } from './submit-feedback'
import type { AuthProps } from '../auth/types'
import { acceptedPermissions } from '../api-permissions'
import type { Connection } from '../api-permissions'
import { apiCallResult } from './api-call-result'
import { toolError } from './tool-error'
import { binaryContent, bodyValue, readResponse } from './response-body'
import type { ScopeChallenge } from '../scope-challenge'
import type { CallPlan } from '../forge-tools/plan'
import { FORGE_ACCOUNT_DISCOVERY_GUIDANCE, PERMISSIONS_EXTENSION } from '../forge-tools/policy'
import { policyRefusalHint, subscriptionCreate } from '../policy-guards'
import { DECLINED_HINT, askToConfirm, canConfirm, confirmationOf } from '../charge-confirmation'

/** The forge tools service, which holds the generated tools (`src/forge-tools/worker.ts`). */
function forgeTools() {
  return env.FORGE_TOOLS
}

/**
 * Serve the direct tools forge generates from `openapi.forge.json`
 * (`?codemode=false`), alongside `docs` and `whoami`.
 *
 * The generated tools live in the forge tools service, a Worker of their own,
 * so that isolates serving Code Mode never compile them. `tools/list` asks it
 * for the tools; `tools/call` asks it for the request a call makes, then sends
 * that request with the session's token, which never leaves this Worker. A
 * refused call is explained, and asks for a step-up when a missing OAuth scope
 * would let it through, as the other direct tools do. A call that creates an
 * account subscription asks the user to confirm it first, when the client can
 * ask (`src/charge-confirmation.ts`).
 *
 * With `outputSchema` (`&experimentalOutputSchema=true`), a 2026-07-28 request
 * lists each tool with its generated output schema, and a successful call
 * returns the part of the response body the output schema describes as
 * `structuredContent`, never truncated: the envelope's `result`, or the whole
 * body when the schema declares `result`, as a paginated list's does.
 */
export function registerForgeTools(
  server: McpServer,
  props: AuthProps,
  formatResult: FormatToolResult,
  connection: Connection,
  scopeChallenge: ScopeChallenge,
  { outputSchema = false, client }: { outputSchema?: boolean; client?: RequestClient } = {}
): void {
  server.server.setRequestHandler('tools/list', async (_request, ctx) => ({
    tools: [
      DOCS_TOOL,
      WHOAMI_TOOL,
      ...feedbackTools(),
      ...(await getForgeToolList({ outputSchema: outputSchema && isModern(ctx) }))
    ]
  }))

  server.server.setRequestHandler('tools/call', async (request, ctx) => {
    const name = request.params.name
    const args = request.params.arguments ?? {}
    let result: CallToolResult | InputRequiredResult

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
      } else if (name === SUBMIT_FEEDBACK_TOOL.name && feedbackTools().length > 0) {
        result = await runSubmitFeedbackTool(args, 'direct', props)
      } else {
        const sessionAccountId = autoResolvedAccountId(props)
        const plan = await forgeTools().plan(name, args, {
          baseUrl: env.CLOUDFLARE_API_BASE,
          ...(sessionAccountId && { sessionAccountId })
        })
        result = await callForgeTool(name, plan, props, formatResult, ctx, {
          connection,
          scopeChallenge,
          structured: outputSchema && isModern(ctx)
        })
      }
    } catch (error) {
      result = toolError(error instanceof Error ? error.message : String(error))
    }

    recordToolCall(
      props,
      name,
      'isError' in result && result.isError === true,
      client && toolCallClient(client, ctx)
    )
    return result
  })
}

async function callForgeTool(
  name: string,
  plan: CallPlan,
  props: AuthProps,
  formatResult: FormatToolResult,
  ctx: ServerContext,
  {
    connection,
    scopeChallenge,
    structured
  }: { connection: Connection; scopeChallenge: ScopeChallenge; structured: boolean }
): Promise<CallToolResult | InputRequiredResult> {
  switch (plan.kind) {
    case 'unknown':
      return toolError(`Tool ${name} not found`)
    case 'invalid':
      return toolError(plan.message)
    case 'needs_account':
      return toolError(
        missingAccountMessage(props, FORGE_ACCOUNT_DISCOVERY_GUIDANCE, plan.argument)
      )
    case 'request':
      break
  }

  const request = new Request(plan.url, { method: plan.method, body: plan.body })
  // Creating a subscription spends money: the user confirms it, or it isn't sent.
  const subscription = canConfirm(ctx) ? await subscriptionCreate(request) : undefined
  if (subscription) {
    const confirmation = confirmationOf(ctx, subscription)
    if (confirmation === 'unasked') {
      return await askToConfirm(subscription)
    }
    if (confirmation === 'declined') {
      return toolError(DECLINED_HINT)
    }
  }
  const refusal = await policyRefusalHint(request, subscription)
  if (refusal) {
    return toolError(refusal)
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
  // A 429's headers say how long to wait; the agent only sees the body.
  const rateLimit = rateLimitHint(response.status, response.headers)
  const body = await readResponse(response)
  const result = bodyValue(body)

  // Background check against the spec's response schema; never affects the result.
  if (body.kind === 'json') {
    checkResponse({
      toolName: name,
      method: plan.method,
      pathTemplate: plan.template,
      status: response.status,
      body: result,
      bodyChars: body.chars,
      props
    })
  }

  const toolResult = apiCallResult(
    {
      method: plan.method,
      path: new URL(plan.url).pathname.slice(new URL(env.CLOUDFLARE_API_BASE).pathname.length),
      template: plan.template,
      permissions: acceptedPermissions({ [PERMISSIONS_EXTENSION]: plan.permissions }),
      status: response.status,
      body: result
    },
    [rateLimit, plan.accountId ? unknownAccountHint(props, plan.accountId) : undefined].filter(
      (note) => note !== undefined
    ),
    { connection, scopeChallenge, formatResult }
  )
  if (toolResult.isError) {
    return toolResult
  }
  // Binary is returned as MCP's own content for it, whole: cutting it would corrupt it.
  if (body.kind === 'binary') {
    return { content: [binaryContent(body, plan.url)] }
  }
  if (!structured || body.kind !== 'json') {
    return toolResult
  }
  // The output schema describes the whole body, as the API sends it.
  return { ...toolResult, structuredContent: result }
}

/**
 * Whether the request is protocol 2026-07-28 or later. Only those carry the
 * per-request `_meta` envelope, which names the protocol version.
 */
function isModern(ctx: ServerContext): boolean {
  // oxlint-disable-next-line quality/no-unsafe-dictionary-type -- The SDK envelope is narrowed at the field used here.
  const envelope: Record<string, unknown> | undefined = ctx.mcpReq.envelope
  return typeof envelope?.[PROTOCOL_VERSION_META_KEY] === 'string'
}

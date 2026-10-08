import { z } from 'zod'
import { env } from 'cloudflare:workers'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import type { FormatToolResult } from '../truncate'
import { fetchWithRetry } from '../utils/fetch-retry'
import { getMcpTools } from '../isolate-cache'
import {
  NON_CODEMODE_ACCOUNT_DISCOVERY_GUIDANCE,
  autoResolvedAccountId,
  missingAccountMessage,
  unknownAccountHint
} from '../auth/account-access'
import { recordToolCall } from '../metrics'
import { DOCS_TOOL, runDocsTool } from './docs-search'
import { WHOAMI_TOOL, WhoamiInputSchema, runWhoamiTool } from './whoami'
import { zodInputSchemaFromJson, type McpTool } from '../openapi'
import type { AuthProps } from '../auth/types'

/**
 * Install lazy non-Code-Mode protocol handlers.
 *
 * Unlike `registerTool`, these handlers do not create ~3,000 closures and Zod
 * schemas per HTTP request. `tools/list` serves `mcp-tools.json` exactly as the
 * scheduled handler generated it (cached per isolate); `tools/call` validates
 * and dispatches only the requested operation.
 * `formatResult` turns each API response body into the tool's text output.
 */
export async function registerNonCodemodeTools(
  server: McpServer,
  props: AuthProps,
  formatResult: FormatToolResult
): Promise<void> {
  const tools = await getMcpTools()

  server.server.setRequestHandler('tools/list', () => ({
    tools: [DOCS_TOOL, WHOAMI_TOOL, ...tools.list]
  }))

  server.server.setRequestHandler('tools/call', async (request) => {
    const name = request.params.name
    let result: CallToolResult

    try {
      if (name === DOCS_TOOL.name) {
        const parsed = z.object({ query: z.string() }).safeParse(request.params.arguments ?? {})
        result = parsed.success
          ? await runDocsTool(parsed.data.query)
          : validationError(name, parsed.error)
      } else if (name === WHOAMI_TOOL.name) {
        const parsed = WhoamiInputSchema.safeParse(request.params.arguments ?? {})
        result = parsed.success ? runWhoamiTool(props) : validationError(name, parsed.error)
      } else {
        const tool = tools.byName.get(name)
        if (!tool) {
          result = toolError(`Tool ${name} not found`)
        } else {
          const parsed = z
            .object(zodInputSchemaFromJson(tool.inputSchema))
            .safeParse(request.params.arguments ?? {})
          result = parsed.success
            ? await callNonCodemodeTool(tool, parsed.data, props, formatResult)
            : validationError(name, parsed.error)
        }
      }
    } catch (error) {
      result = toolError(error instanceof Error ? error.message : String(error))
    }

    recordToolCall(props, name, result.isError === true)
    return result
  })
}

async function callNonCodemodeTool(
  tool: McpTool,
  params: Record<string, unknown>,
  props: AuthProps,
  formatResult: FormatToolResult
): Promise<CallToolResult> {
  let resolvedPath = tool.path
  const pathParams = [...tool.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])

  for (const paramName of pathParams) {
    let value = params[paramName] as string | undefined
    if (paramName === 'account_id' && !value) value = autoResolvedAccountId(props)
    if (!value && paramName === 'account_id') {
      return toolError(missingAccountMessage(props, NON_CODEMODE_ACCOUNT_DISCOVERY_GUIDANCE))
    }
    if (!value) return toolError(`missing required path parameter: ${paramName}`)
    resolvedPath = resolvedPath.replace(`{${paramName}}`, encodeURIComponent(value))
  }

  const url = new URL(env.CLOUDFLARE_API_BASE + resolvedPath)
  for (const paramName of tool.queryParams) {
    if (params[paramName] !== undefined) {
      url.searchParams.set(paramName, String(params[paramName]))
    }
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${props.accessToken}` }
  for (const { name, key } of tool.headerParams) {
    if (params[key] !== undefined) headers[name] = String(params[key])
  }

  let body: string | undefined
  if (params['body']) {
    headers['Content-Type'] = (params['content_type'] as string) || 'application/json'
    body = params['body'] as string
  }

  const response = await fetchWithRetry(
    url.toString(),
    { method: tool.method.toUpperCase(), headers, body },
    { caller: 'non_codemode_tool_call' }
  )
  const contentType = response.headers.get('content-type') || ''
  const result = contentType.includes('application/json')
    ? await response.json()
    : await response.text()

  const accountId = params['account_id'] as string | undefined
  const hint = !response.ok && accountId ? unknownAccountHint(props, accountId) : ''
  return {
    content: [{ type: 'text', text: formatResult(result) + (hint ? `\n\n${hint}` : '') }],
    isError: !response.ok
  }
}

function validationError(name: string, error: z.ZodError): CallToolResult {
  const accountGuidance = error.issues.some((issue) => issue.path[0] === 'account_id')
    ? ` ${NON_CODEMODE_ACCOUNT_DISCOVERY_GUIDANCE}`
    : ''
  return toolError(
    `Input validation error: Invalid arguments for tool ${name}: ${error.message}${accountGuidance}`
  )
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

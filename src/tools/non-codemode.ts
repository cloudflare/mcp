import { z } from 'zod'
import { env } from 'cloudflare:workers'
import type { McpServer, CallToolResult, Tool } from '@modelcontextprotocol/server'
import { truncateResponse } from '../truncate'
import { fetchWithRetry } from '../utils/fetch-retry'
import { getNonCodemodeToolMap, getNonCodemodeTools } from '../isolate-cache'
import {
  NON_CODEMODE_ACCOUNT_DISCOVERY_GUIDANCE,
  autoResolvedAccountId,
  isMultiAccountUser
} from '../auth/account-access'
import { recordToolCall } from '../metrics'
import { DOCS_TOOL, runDocsTool } from './docs-search'
import { zodInputSchemaFromJson, type NonCodemodeTool } from '../openapi'
import type { AuthProps } from '../auth/types'

/**
 * Install lazy non-Code-Mode protocol handlers.
 *
 * Unlike `registerTool`, these handlers do not create ~3,000 closures and Zod
 * schemas per HTTP request. `tools/list` serves the precomputed JSON artifact;
 * `tools/call` validates and dispatches only the requested operation.
 */
export async function registerNonCodemodeTools(server: McpServer, props: AuthProps): Promise<void> {
  const tools = await getNonCodemodeTools()
  const toolsByName = await getNonCodemodeToolMap()
  const resolvedAccountId = autoResolvedAccountId(props)

  server.server.registerCapabilities({ tools: { listChanged: false } })

  server.server.setRequestHandler('tools/list', () => ({
    tools: [
      DOCS_TOOL,
      ...tools.map((tool) => toWireTool(toolForAccountAccess(tool, resolvedAccountId, props)))
    ]
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
      } else {
        const baseTool = toolsByName.get(name)
        if (!baseTool) {
          result = toolError(`Tool ${name} not found`)
        } else {
          const tool = toolForAccountAccess(baseTool, resolvedAccountId, props)
          const parsed = z
            .object(zodInputSchemaFromJson(tool.inputSchema))
            .safeParse(request.params.arguments ?? {})
          result = parsed.success
            ? await callNonCodemodeTool(baseTool, parsed.data, resolvedAccountId, props.accessToken)
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
  tool: NonCodemodeTool,
  params: Record<string, unknown>,
  resolvedAccountId: string | undefined,
  apiToken: string
): Promise<CallToolResult> {
  let resolvedPath = tool.path
  const pathParams = [...tool.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])

  for (const paramName of pathParams) {
    let value = params[paramName] as string | undefined
    if (paramName === 'account_id' && !value) value = resolvedAccountId
    if (!value) return toolError(`missing required path parameter: ${paramName}`)
    resolvedPath = resolvedPath.replace(`{${paramName}}`, encodeURIComponent(value))
  }

  const url = new URL(env.CLOUDFLARE_API_BASE + resolvedPath)
  for (const paramName of tool.queryParams) {
    if (params[paramName] !== undefined) {
      url.searchParams.set(paramName, String(params[paramName]))
    }
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${apiToken}` }
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
  const text = contentType.includes('application/json')
    ? JSON.stringify(await response.json(), null, 2)
    : await response.text()

  return {
    content: [{ type: 'text', text: truncateResponse(text) }],
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

function toWireTool(tool: NonCodemodeTool): Tool {
  const { name, description, inputSchema } = tool
  return { name, description, inputSchema }
}

function toolForAccountAccess(
  tool: NonCodemodeTool,
  resolvedAccountId: string | undefined,
  props: AuthProps
): NonCodemodeTool {
  if (!tool.inputSchema.properties['account_id']) return tool

  const properties = { ...tool.inputSchema.properties }
  let required = tool.inputSchema.required

  if (resolvedAccountId) {
    delete properties['account_id']
    required = required?.filter((name) => name !== 'account_id')
  } else if (isMultiAccountUser(props)) {
    properties['account_id'] = {
      type: 'string',
      description: `Cloudflare account ID. Required for multi-account tokens. ${NON_CODEMODE_ACCOUNT_DISCOVERY_GUIDANCE}`
    }
  }

  const inputSchema = { ...tool.inputSchema, properties, required }
  if (required?.length === 0) delete inputSchema.required
  return { ...tool, inputSchema }
}

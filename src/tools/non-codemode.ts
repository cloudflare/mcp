import { z } from 'zod'
import { env } from 'cloudflare:workers'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { truncateResponse } from '../truncate'
import { fetchWithRetry } from '../utils/fetch-retry'
import { getNonCodemodeTools, getZodInputSchema } from '../isolate-cache'
import { autoResolvedAccountId, isMultiAccountUser } from '../auth/account-access'
import { formatError } from '../utils/errors'
import { DOCS_TOOL } from './docs-search'
import type { AuthProps } from '../auth/types'
import type { NonCodemodeTool } from '../openapi'

/**
 * Register one MCP tool per OpenAPI operation (non-Code-Mode passthrough mode).
 * Each tool maps directly to a Cloudflare REST endpoint: path/query/header
 * params and a JSON/raw body are forwarded straight through.
 */
export async function registerNonCodemodeTools(server: McpServer, props: AuthProps): Promise<void> {
  const apiToken = props.accessToken
  // Account id resolvable without asking the user (account token or
  // single-account user token); undefined when the caller must choose.
  const resolvedAccountId = autoResolvedAccountId(props)

  // Spec-derived tool definitions (names, descriptions, base input schemas) are
  // built once per isolate and cached; only the per-request account_id handling
  // and the handler closure are rebuilt here.
  const precomputedTools = await getNonCodemodeTools()
  const apiBase = env.CLOUDFLARE_API_BASE
  const tools = precomputedTools.map((tool) => toolForAccountAccess(tool, resolvedAccountId, props))

  for (const [index, tool] of tools.entries()) {
    const baseTool = precomputedTools[index]
    const { name, description, method, path, queryParams, headerParams } = tool
    const inputSchema = { ...getZodInputSchema(baseTool.inputSchema) }
    if (baseTool.inputSchema.properties['account_id']) {
      if (resolvedAccountId) {
        delete inputSchema['account_id']
      } else if (isMultiAccountUser(props)) {
        inputSchema['account_id'] = z
          .string()
          .describe('Cloudflare account ID. Required for multi-account tokens.')
      }
    }

    server.registerTool(name, { description, inputSchema }, async (params) => {
      try {
        // Build the URL with path parameters substituted
        let resolvedPath = path
        const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])
        for (const paramName of pathParams) {
          let value = params[paramName] as string | undefined

          // Auto-resolve account_id from the token when not supplied.
          if (paramName === 'account_id' && !value) {
            value = resolvedAccountId
          }

          if (!value) {
            return formatError(`missing required path parameter: ${paramName}`)
          }
          resolvedPath = resolvedPath.replace(`{${paramName}}`, encodeURIComponent(value))
        }

        // Build query string
        const url = new URL(apiBase + resolvedPath)
        for (const paramName of queryParams) {
          if (params[paramName] !== undefined) {
            url.searchParams.set(paramName, String(params[paramName]))
          }
        }

        // Build request
        const headers: Record<string, string> = {
          Authorization: `Bearer ${apiToken}`
        }

        // Add header parameters
        for (const { name: headerName, key } of headerParams) {
          if (params[key] !== undefined) {
            headers[headerName] = String(params[key])
          }
        }

        let requestBody: string | undefined
        if (params['body']) {
          headers['Content-Type'] = (params['content_type'] as string) || 'application/json'
          requestBody = params['body'] as string
        }

        const response = await fetchWithRetry(
          url.toString(),
          {
            method: method.toUpperCase(),
            headers,
            body: requestBody
          },
          { caller: 'non_codemode_tool_call' }
        )

        const contentType = response.headers.get('content-type') || ''
        let result: string

        if (contentType.includes('application/json')) {
          const data = await response.json()
          result = JSON.stringify(data, null, 2)
        } else {
          result = await response.text()
        }

        return {
          content: [{ type: 'text' as const, text: truncateResponse(result) }],
          isError: !response.ok
        }
      } catch (error) {
        return formatError(error)
      }
    })
  }

  // registerTool installed the SDK's standard tools/call + tools/list handlers.
  // Keep tools/call (Zod validation, metrics, task/error handling) untouched,
  // but replace tools/list so it returns JSON Schema built by the scheduled
  // task rather than converting ~2,500 Zod schemas on every list request.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [DOCS_TOOL, ...tools.map(toWireTool)]
  }))
}

function toWireTool(tool: NonCodemodeTool): Tool {
  const { name, description, inputSchema, execution } = tool
  return { name, description, inputSchema, execution }
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
      description: 'Cloudflare account ID. Required for multi-account tokens.'
    }
  }

  const inputSchema = { ...tool.inputSchema, properties, required }
  if (required?.length === 0) delete inputSchema.required
  return { ...tool, inputSchema }
}

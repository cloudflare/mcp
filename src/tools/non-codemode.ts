import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { truncateResponse } from '../truncate'
import { fetchWithRetry } from '../utils/fetch-retry'
import { buildInputSchema, pathToToolName, type OperationInfo } from '../openapi'
import { isMultiAccountUser } from '../auth/account-access'
import type { AuthProps } from '../auth/types'

/**
 * Register one MCP tool per OpenAPI operation (non-Code-Mode passthrough mode).
 * Each tool maps directly to a Cloudflare REST endpoint: path/query/header
 * params and a JSON/raw body are forwarded straight through.
 */
export async function registerNonCodemodeTools(
  server: McpServer,
  env: Env,
  apiToken: string,
  // Account id resolvable without asking the user (account token or
  // single-account user token); undefined when the caller must choose.
  resolvedAccountId: string | undefined,
  props?: AuthProps
): Promise<void> {
  const obj = await env.SPEC_BUCKET.get('spec.json')
  if (!obj) throw new Error('spec.json not found in R2. Run the scheduled handler to populate it.')
  const spec = (await obj.json()) as { paths: Record<string, Record<string, OperationInfo>> }
  const apiBase = env.CLOUDFLARE_API_BASE
  const registeredNames = new Set<string>()

  const methods = ['get', 'post', 'put', 'patch', 'delete'] as const

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of methods) {
      const operation = pathItem[method]
      if (!operation) continue

      let toolName = pathToToolName(method, path)
      // Deduplicate if truncation caused a collision
      if (registeredNames.has(toolName)) {
        let i = 2
        let candidate: string
        do {
          const suffixStr = `_${i}`
          const maxBase = 128 - suffixStr.length
          const base =
            toolName.length > maxBase ? toolName.slice(0, maxBase).replace(/_$/, '') : toolName
          candidate = `${base}${suffixStr}`
          i++
        } while (registeredNames.has(candidate))
        toolName = candidate
      }
      registeredNames.add(toolName)
      const description =
        `${method.toUpperCase()} ${path}` +
        (operation.summary ? `\n\n${operation.summary}` : '') +
        (operation.description ? `\n\n${operation.description}` : '')

      const inputSchema = buildInputSchema(operation, path)

      // account_id is fully auto-resolved for account-token and single-account
      // user-token sessions, so drop it from the schema entirely — the handler
      // substitutes resolvedAccountId. Keeps hundreds of account-scoped tool
      // schemas lean and stops the model passing a value that can only be wrong.
      if (path.includes('{account_id}') && resolvedAccountId) {
        delete inputSchema['account_id']
      }

      // For multi-account user tokens account_id genuinely cannot be resolved,
      // so keep it required (buildInputSchema already added it) with a clearer
      // description.
      const needsAccountId =
        !resolvedAccountId && path.includes('{account_id}') && isMultiAccountUser(props)

      if (needsAccountId) {
        inputSchema['account_id'] = z
          .string()
          .describe('Cloudflare account ID. Required for multi-account tokens.')
      }

      server.registerTool(toolName, { description, inputSchema }, async (params) => {
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
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `Error: missing required path parameter: ${paramName}`
                  }
                ],
                isError: true
              }
            }
            resolvedPath = resolvedPath.replace(`{${paramName}}`, encodeURIComponent(value))
          }

          // Build query string
          const url = new URL(apiBase + resolvedPath)
          if (operation.parameters) {
            for (const param of operation.parameters) {
              if (param.in === 'query' && params[param.name] !== undefined) {
                url.searchParams.set(param.name, String(params[param.name]))
              }
            }
          }

          // Build request
          const headers: Record<string, string> = {
            Authorization: `Bearer ${apiToken}`
          }

          // Add header parameters
          if (operation.parameters) {
            for (const param of operation.parameters) {
              if (param.in === 'header') {
                const headerKey = `header_${param.name.toLowerCase().replace(/-/g, '_')}`
                if (params[headerKey] !== undefined) {
                  headers[param.name] = String(params[headerKey])
                }
              }
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
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: ${error instanceof Error ? error.message : String(error)}`
              }
            ],
            isError: true
          }
        }
      })
    }
  }
}

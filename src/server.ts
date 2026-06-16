import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { registerDocsTool } from './tools/docs-search'
import { registerNonCodemodeTools } from './tools/non-codemode'
import { createCodeExecutor, createSearchExecutor } from './executor'
import { truncateResponse } from './truncate'
import { attachMetrics, SERVER_INFO } from './metrics'
import {
  accountIdParamDescription,
  executeToolDescription,
  searchToolDescription
} from './descriptions'
import { accountTokenId, autoResolvedAccountId } from './auth/account-access'
import { formatError } from './utils/errors'
import type { AuthProps } from './auth/types'

export async function createServer(
  env: Env,
  ctx: ExecutionContext,
  props: AuthProps,
  codemode = true
): Promise<McpServer> {
  const apiToken = props.accessToken
  // Account id usable without asking the user (account token, or single-account
  // user token); undefined when the model must choose per call.
  const resolvedAccountId = autoResolvedAccountId(props)

  const server = new McpServer(SERVER_INFO)

  // Track tool_call metrics for every tool registered below.
  attachMetrics(server, env, props)

  registerDocsTool(server, env)

  if (!codemode) {
    await registerNonCodemodeTools(server, env, apiToken, resolvedAccountId, props)
    return server
  }

  const executeCode = createCodeExecutor(env, ctx)
  const executeSearch = createSearchExecutor(env)

  const obj = await env.SPEC_BUCKET.get('products.json')
  const products: string[] = obj ? await obj.json() : []

  server.registerTool(
    'search',
    {
      description: searchToolDescription(products),
      inputSchema: {
        code: z.string().describe('JavaScript async arrow function to search the OpenAPI spec')
      }
    },
    async ({ code }) => {
      try {
        const result = await executeSearch(code)
        return { content: [{ type: 'text', text: truncateResponse(result) }] }
      } catch (error) {
        return formatError(error)
      }
    }
  )

  const executeDescription = executeToolDescription(props)
  const pinnedAccountId = accountTokenId(props)

  if (pinnedAccountId) {
    // Account token mode: account_id is fixed, not a parameter
    server.registerTool(
      'execute',
      {
        description: executeDescription,
        inputSchema: {
          code: z.string().describe('JavaScript async arrow function to execute')
        }
      },
      async ({ code }) => {
        try {
          const result = await executeCode(code, pinnedAccountId, apiToken)
          return { content: [{ type: 'text', text: truncateResponse(result) }] }
        } catch (error) {
          return formatError(error)
        }
      }
    )
  } else {
    // User token mode: account_id selects the account for account-scoped calls.
    // It may be omitted for account-independent discovery calls such as GET /accounts.
    server.registerTool(
      'execute',
      {
        description: executeDescription,
        inputSchema: {
          code: z.string().describe('JavaScript async arrow function to execute'),
          account_id: z.string().optional().describe(accountIdParamDescription(props))
        }
      },
      async ({ code, account_id }) => {
        try {
          // Undefined accountId lets account-independent requests such as
          // GET /accounts run before the caller has selected an account; any
          // code that reads `accountId` then fails fast with a clear message.
          const effectiveAccountId = account_id || autoResolvedAccountId(props)

          const result = await executeCode(code, effectiveAccountId, apiToken)
          return { content: [{ type: 'text', text: truncateResponse(result) }] }
        } catch (error) {
          return formatError(error)
        }
      }
    )
  }

  return server
}

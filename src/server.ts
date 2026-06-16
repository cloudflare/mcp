import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerDocsTool } from './tools/docs-search'
import { registerNonCodemodeTools } from './tools/non-codemode'
import { registerSearchTool } from './tools/search'
import { registerExecuteTool } from './tools/execute'
import { attachMetrics } from './metrics'
import { SERVER_INFO } from './constants'
import { autoResolvedAccountId } from './auth/account-access'
import type { AuthProps } from './auth/types'

export async function createServer(
  env: Env,
  ctx: ExecutionContext,
  props: AuthProps,
  codemode = true
): Promise<McpServer> {
  const server = new McpServer(SERVER_INFO)

  // Track tool_call metrics for every tool registered below.
  attachMetrics(server, env, props)

  registerDocsTool(server, env)

  if (!codemode) {
    // Account id usable without asking the user (account token, or
    // single-account user token); undefined when the model must choose.
    const resolvedAccountId = autoResolvedAccountId(props)
    await registerNonCodemodeTools(server, env, props.accessToken, resolvedAccountId, props)
    return server
  }

  await registerSearchTool(server, env)
  registerExecuteTool(server, env, ctx, props)

  return server
}

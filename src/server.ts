import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerDocsTool } from './tools/docs-search'
import { registerNonCodemodeTools } from './tools/non-codemode'
import { registerSearchTool } from './tools/search'
import { registerExecuteTool } from './tools/execute'
import { attachMetrics } from './metrics'
import { SERVER_INFO } from './constants'
import type { AuthProps } from './auth/types'

export async function createServer(props: AuthProps, codemode = true): Promise<McpServer> {
  const server = new McpServer(SERVER_INFO)

  // Track tool_call metrics for every tool registered below.
  attachMetrics(server, props)

  registerDocsTool(server)

  if (!codemode) {
    await registerNonCodemodeTools(server, props)
    return server
  }

  await registerSearchTool(server)
  registerExecuteTool(server, props)

  return server
}

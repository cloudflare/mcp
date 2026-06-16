/**
 * Shared MCP server identity (name + version).
 *
 * Lives in its own zero-dependency module because it is consumed across layers:
 * the MCP server handshake (`new McpServer(SERVER_INFO)`) and the metrics
 * tracker (reported as blob1/blob2 on every datapoint, in both the request path
 * and the OAuth handler).
 */
export type ServerInfo = { name: string; version: string }

export const SERVER_INFO: ServerInfo = { name: 'cloudflare-api', version: '0.1.0' }

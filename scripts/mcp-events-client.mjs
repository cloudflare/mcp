const method = process.argv[2] ?? 'list'
if (!['list', 'subscribe', 'unsubscribe'].includes(method))
  throw new Error('Usage: node scripts/mcp-events-client.mjs list|subscribe|unsubscribe')
const token = process.env.CLOUDFLARE_API_TOKEN
if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN')
const endpoint = process.env.MCP_URL ?? 'http://localhost:2529/mcp'
const params = {
  _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'mcp-events-local-test', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {}
  }
}
if (method !== 'list') {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const callbackUrl = process.env.MCP_EVENT_CALLBACK_URL
  if (!accountId || !callbackUrl)
    throw new Error('Set CLOUDFLARE_ACCOUNT_ID and MCP_EVENT_CALLBACK_URL')
  params.name = 'cloudflare.alert.workers_observability_real_time_issue'
  params.arguments = {
    account_id: accountId,
    afterOccurrences: 1,
    ...(process.env.MCP_EVENT_WORKER ? { service: process.env.MCP_EVENT_WORKER } : {})
  }
  params.delivery = { mode: 'webhook', url: callbackUrl }
  if (method === 'subscribe') {
    if (!process.env.MCP_EVENT_SIGNING_SECRET)
      throw new Error('Set MCP_EVENT_SIGNING_SECRET to the receiver’s key')
    params.delivery.secret = process.env.MCP_EVENT_SIGNING_SECRET
  }
}
const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': `events/${method}`,
    ...(params.name ? { 'Mcp-Name': params.name } : {})
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: `events/${method}`, params })
})
const text = await response.text()
const data = response.headers.get('content-type')?.includes('text/event-stream')
  ? text
      .split('\n')
      .find((line) => line.startsWith('data:'))
      ?.slice(5)
  : text
const result = JSON.parse(data)
console.log(JSON.stringify(result, null, 2))
if (!response.ok || result.error) process.exitCode = 1

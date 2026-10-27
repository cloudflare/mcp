import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, mcpToolListRequest, modernMcpRequest, parseMcpResult } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'

/**
 * Every tool declares OpenAI's per-tool `securitySchemes` in `_meta`, the MCP
 * extension point, so ChatGPT can show its re-authorization prompt when a call
 * is refused for a missing scope.
 */

const TOKEN = 'cfat_security-schemes-test-token'
const IDENTITY = [{ type: 'oauth2', scopes: ['user:read', 'account:read'] }]

beforeEach(async () => {
  await seedSpec({
    '/zones/{zone_id}/dns_records': {
      get: { summary: 'List DNS Records', parameters: [{ name: 'zone_id', in: 'path' }] }
    }
  })
  mockIdentityProbe({ accounts: [{ id: 'acc-1', name: 'Acc' }] })
})

afterEach(async () => {
  await clearSpec()
  await clearKv(env.OAUTH_KV)
})

type ListedTool = { name: string; _meta?: Record<string, unknown> }

async function listTools(era: '2025' | '2026', query = ''): Promise<ListedTool[]> {
  const url = `${MCP_URL}${query}`
  const request =
    era === '2026'
      ? modernMcpRequest(TOKEN, 'tools/list', {}, { url })
      : new Request(url, mcpToolListRequest(TOKEN))
  const body = await parseMcpResult(await exports.default.fetch(request))
  return (body.result?.tools ?? []) as ListedTool[]
}

describe.each(['2025', '2026'] as const)('tools/list over %s-era HTTP', (era) => {
  it('declares an OAuth scheme on every Code Mode tool', async () => {
    const tools = await listTools(era)

    expect(tools.map((tool) => tool.name).sort()).toEqual(['docs', 'execute', 'search', 'whoami'])
    for (const tool of tools) expect(tool._meta?.securitySchemes).toEqual(IDENTITY)
  })

  it('declares an OAuth scheme on every endpoint tool', async () => {
    const tools = await listTools(era, '?codemode=false')

    expect(tools.map((tool) => tool.name)).toContain('get_zones_dns_records')
    for (const tool of tools) expect(tool._meta?.securitySchemes).toEqual(IDENTITY)
  })

  it('keeps whoami marked as the profile tool', async () => {
    for (const query of ['', '?codemode=false']) {
      const whoami = (await listTools(era, query)).find((tool) => tool.name === 'whoami')
      expect(whoami?._meta).toEqual({ 'openai/profile': true, securitySchemes: IDENTITY })
    }
  })
})

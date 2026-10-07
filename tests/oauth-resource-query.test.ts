import { env, exports } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import { mcpToolListRequest, MCP_URL, parseMcpResult } from './helpers/mcp'
import { clearKv } from './helpers/kv'
import { connectWithOAuth } from './helpers/oauth'
import { clearSpec, seedSpec } from './helpers/spec'

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

/**
 * MCP clients such as OpenCode v2 name the URL they were configured with as the
 * RFC 8707 resource, query string included. workers-oauth-provider 1.2.3 maps
 * it to the configured /mcp resource (cloudflare/workers-oauth-provider#408).
 */
describe('OAuth with the configured MCP URL as the resource', () => {
  it('authorizes a client that names /mcp?codemode=false and the token works there', async () => {
    await seedSpec({})
    const token = await connectWithOAuth(
      ['user:read', 'account:read'],
      undefined,
      `${MCP_URL}?codemode=false`
    )

    expect(token).toMatch(/\S/)
    const listed = await parseMcpResult(
      await exports.default.fetch(
        new Request(`${MCP_URL}?codemode=false`, mcpToolListRequest(token))
      )
    )
    expect(listed.result?.tools?.map((tool) => tool.name)).toContain('whoami')
  })

  it('still rejects a resource this server does not host', async () => {
    await expect(
      connectWithOAuth(['user:read', 'account:read'], undefined, 'https://evil.example/mcp')
    ).rejects.toThrow('consent handle')
  })
})

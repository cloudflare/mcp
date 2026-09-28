import { env, exports } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeRedirectUri } from '../../src/auth/registration-log'
import { clearKv } from '../helpers/kv'

const MCP_ORIGIN = 'https://mcp.cloudflare.com'

function register(metadata: Record<string, unknown>): Promise<Response> {
  return exports.default.fetch(
    new Request(`${MCP_ORIGIN}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Cursor/1.0.0' },
      body: JSON.stringify(metadata)
    })
  )
}

/** The `dcr_refused` lines among everything passed to console.warn. */
function refusalLogs(calls: readonly unknown[][]): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = []
  for (const [line] of calls) {
    if (typeof line !== 'string' || !line.startsWith('{')) continue
    const entry: unknown = JSON.parse(line)
    if (
      typeof entry === 'object' &&
      entry !== null &&
      'event' in entry &&
      entry.event === 'dcr_refused'
    ) {
      entries.push(entry as Record<string, unknown>)
    }
  }
  return entries
}

describe('refused registration diagnostics', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await clearKv(env.OAUTH_KV)
  })

  it('logs what a refused client asked for, without queries or credentials', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await register({
      client_name: 'Agent host',
      redirect_uris: ['grokbot://mcp/oauth/callback', 'http://user:pw@remote.example/cb?code=x#f'],
      token_endpoint_auth_method: 'none'
    })

    expect(response.status).toBe(400)
    // The client still gets the provider's error; the log reads a copy.
    expect(await response.json()).toMatchObject({ error: 'invalid_client_metadata' })
    await vi.waitFor(() => expect(refusalLogs(warn.mock.calls)).toHaveLength(1))
    expect(refusalLogs(warn.mock.calls)[0]).toMatchObject({
      status: 400,
      error: 'invalid_client_metadata',
      userAgent: 'Cursor/1.0.0',
      clientName: 'Agent host',
      redirectUris: ['grokbot://mcp/oauth/callback', 'http://remote.example/cb'],
      redirectUriCount: 2
    })
  })

  it('logs nothing for a registration it accepts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const response = await register({
      client_name: 'Loopback client',
      redirect_uris: ['http://localhost:8787/callback'],
      token_endpoint_auth_method: 'none'
    })

    expect(response.status).toBe(201)
    await response.body?.cancel()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(refusalLogs(warn.mock.calls)).toHaveLength(0)
  })

  it('keeps only the scheme of a redirect URI it cannot parse', () => {
    expect(describeRedirectUri('not a url')).toBe('(unparseable, scheme none)')
    expect(describeRedirectUri(42)).toBe('(not a string)')
  })
})

import { describe, expect, it } from 'vitest'
import { rejectInvalidMcpRequest } from '../src/mcp-handler'

function requestFor(host: string, origin?: string): Request {
  return new Request(`https://${host}/mcp`, {
    method: 'POST',
    headers: { Host: host, ...(origin ? { Origin: origin } : {}) }
  })
}

describe('deployed MCP hostname', () => {
  it('accepts the hostname of the deployment MCP_RESOURCE names', () => {
    const host = 'pr-42.mcp-preview.example.dev'
    expect(
      rejectInvalidMcpRequest(requestFor(host, `https://${host}`), `https://${host}/mcp`)
    ).toBeUndefined()
  })

  it('rejects that hostname when MCP_RESOURCE names a different deployment', () => {
    const response = rejectInvalidMcpRequest(
      requestFor('pr-42.mcp-preview.example.dev'),
      'https://mcp.cloudflare.com/mcp'
    )
    expect(response?.status).toBe(403)
  })

  it('does not trust a plain-HTTP or malformed MCP_RESOURCE', () => {
    expect(
      rejectInvalidMcpRequest(requestFor('evil.example'), 'http://evil.example/mcp')?.status
    ).toBe(403)
    expect(rejectInvalidMcpRequest(requestFor('evil.example'), 'not a url')?.status).toBe(403)
  })

  it('keeps accepting the production hostname without MCP_RESOURCE', () => {
    expect(rejectInvalidMcpRequest(requestFor('mcp.cloudflare.com'))).toBeUndefined()
  })
})

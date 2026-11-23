import { describe, expect, it } from 'vitest'
import { declaresMcpApps, mcpAppsLogLine, withoutAppView } from '../src/mcp-apps/capability'
import { MCP_APP_MIME } from '../src/mcp-apps/define'
import { MCP_APP_TEXT_TOOLS, MCP_APP_TOOLS } from '../src/mcp-apps/registry'

function request(meta: Record<string, unknown> | undefined) {
  return { jsonrpc: '2.0', id: 1, method: 'tools/list', params: meta ? { _meta: meta } : {} }
}

const MODERN = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }

function capabilities(ui: unknown) {
  return {
    ...MODERN,
    'io.modelcontextprotocol/clientCapabilities': {
      extensions: { 'io.modelcontextprotocol/ui': ui }
    }
  }
}

describe('declaresMcpApps', () => {
  it('is true for a 2026-07-28 request that declares the App MIME type', () => {
    expect(
      declaresMcpApps(request(capabilities({ mimeTypes: ['text/plain', MCP_APP_MIME] })))
    ).toBe(true)
  })

  it('ignores whitespace and case in the MIME type', () => {
    expect(
      declaresMcpApps(request(capabilities({ mimeTypes: ['Text/HTML; profile=mcp-app'] })))
    ).toBe(true)
  })

  it.each([
    ['no body', undefined],
    ['a 2025-era request', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
    [
      'a 2025-era request with capabilities but no protocol version',
      request({
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [MCP_APP_MIME] } }
        }
      })
    ],
    ['no capabilities', request(MODERN)],
    ['the extension without MIME types', request(capabilities({}))],
    ['other MIME types only', request(capabilities({ mimeTypes: ['text/html'] }))],
    ['MIME types that are not a list', request(capabilities({ mimeTypes: MCP_APP_MIME }))],
    ['a batch', [request(capabilities({ mimeTypes: [MCP_APP_MIME] }))]]
  ])('is false for %s', (_case, body) => {
    expect(declaresMcpApps(body)).toBe(false)
  })
})

describe('mcpAppsLogLine', () => {
  it('names the method, the declaration and the client', () => {
    expect(
      mcpAppsLogLine(
        request({ ...MODERN, 'io.modelcontextprotocol/clientInfo': { name: 'claude-ai' } }),
        true
      )
    ).toBe('mcp_apps tools/list: declared=true client="claude-ai"')
    expect(mcpAppsLogLine(request(MODERN), false)).toBe(
      'mcp_apps tools/list: declared=false client=<none>'
    )
  })

  it('names the tool of a call', () => {
    const call = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'alerting_policies_create', _meta: MODERN }
    }
    expect(mcpAppsLogLine(call, true)).toBe(
      'mcp_apps tools/call: declared=true client=<none> tool="alerting_policies_create"'
    )
  })

  it('quotes and cuts a hostile client name', () => {
    const name = 'x\nfake line' + 'y'.repeat(200)
    const line = mcpAppsLogLine(
      request({ ...MODERN, 'io.modelcontextprotocol/clientInfo': { name } }),
      false
    )!
    expect(line).not.toContain('\n')
    expect(line.length).toBeLessThan(140)
  })

  it('is undefined for 2025-era requests and other methods', () => {
    expect(mcpAppsLogLine({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, false)).toBeUndefined()
    expect(mcpAppsLogLine({ ...request(MODERN), method: 'resources/list' }, false)).toBeUndefined()
  })
})

describe('withoutAppView', () => {
  it('drops only the keys that link a tool to its view', () => {
    const tool = {
      name: 't',
      inputSchema: { type: 'object' as const },
      _meta: { ui: { resourceUri: 'ui://x' }, 'ui/resourceUri': 'ui://x', other: 1 }
    }
    expect(withoutAppView(tool)).toEqual({ ...tool, _meta: { other: 1 } })
  })

  it('lists every App tool without _meta, otherwise unchanged', () => {
    MCP_APP_TEXT_TOOLS.forEach((tool, index) => {
      const { _meta, ...rest } = MCP_APP_TOOLS[index]!
      expect(_meta).toBeDefined()
      expect(tool).toEqual(rest)
    })
  })
})

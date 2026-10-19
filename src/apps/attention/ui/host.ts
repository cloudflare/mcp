import type { CallToolResult } from '@modelcontextprotocol/server'

export interface HostContext {
  theme?: 'light' | 'dark'
  displayMode?: string
  styles?: { variables?: Record<string, string | undefined> }
}

export interface HostHandlers {
  onToolInput: (args: Record<string, unknown>) => void
  onToolResult: (result: CallToolResult) => void
  onContext: (context: HostContext) => void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

const UI_PROTOCOL_VERSION = '2026-01-26'
const TOOL_CALL_TIMEOUT_MS = 20_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value.content)
}

export class HostBridge {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly handlers: HostHandlers) {
    window.addEventListener('message', (event) => this.receive(event))
  }

  async connect(): Promise<void> {
    const result = await this.request('ui/initialize', {
      protocolVersion: UI_PROTOCOL_VERSION,
      appInfo: { name: 'Cloudflare: needs attention', version: '0.2.0' },
      appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] }
    })
    if (isRecord(result) && isRecord(result.hostContext))
      this.handlers.onContext(result.hostContext)
    this.notify('ui/notifications/initialized', {})
  }

  sendFollowUp(text: string): Promise<unknown> {
    return this.request('ui/message', { role: 'user', content: [{ type: 'text', text }] })
  }

  openLink(url: string): Promise<unknown> {
    return this.request('ui/open-link', { url })
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const result = await this.request('tools/call', { name, arguments: args }, TOOL_CALL_TIMEOUT_MS)
    if (!isToolResult(result)) throw new Error('The host returned an invalid tool result')
    return result
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++
    window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*')
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      if (timeoutMs === undefined) return
      setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
    })
  }

  private notify(method: string, params: unknown): void {
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*')
  }

  private receive(event: MessageEvent): void {
    if (event.source !== window.parent) return
    const message = event.data
    if (!message || message.jsonrpc !== '2.0') return
    const waiter = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
    if (waiter) {
      this.pending.delete(message.id)
      if (message.error) waiter.reject(message.error)
      else waiter.resolve(message.result)
      return
    }
    if (message.method === 'ui/notifications/tool-input') {
      this.handlers.onToolInput(message.params?.arguments ?? {})
    } else if (message.method === 'ui/notifications/tool-result') {
      this.handlers.onToolResult(message.params)
    } else if (message.method === 'ui/notifications/host-context-changed') {
      this.handlers.onContext(message.params ?? {})
    }
  }
}

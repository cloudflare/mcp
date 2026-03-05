import { useState, useEffect, useRef, useCallback } from 'react'
import { useAgent } from 'agents/react'
import { useAgentChat } from '@cloudflare/ai-chat/react'
import { isToolUIPart } from 'ai'
import type { MCPServersState } from 'agents'
import { Streamdown } from 'streamdown'
import { ToolCard } from './ToolCard'
import type { MCPServer } from '@/components/Hero/mcpServers'
import {
  PaperPlaneRight,
  Trash,
  CircleNotch,
  Stop,
} from '@phosphor-icons/react'

type McpStatus = 'disconnected' | 'authenticating' | 'connecting' | 'ready'

const SESSION_KEY = 'mcp-chat-session'

function getOrCreateSessionId(): string {
  let id = localStorage.getItem(SESSION_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(SESSION_KEY, id)
  }
  return id
}

function getMcpStatus(mcpState: MCPServersState): { status: McpStatus; authUrl?: string } {
  const servers = Object.values(mcpState.servers)
  if (servers.length === 0) return { status: 'disconnected' }

  const server = servers[0]
  if (server.state === 'authenticating' && server.auth_url) {
    return { status: 'authenticating', authUrl: server.auth_url }
  }
  if (server.state === 'ready') {
    return { status: 'ready' }
  }
  return { status: 'connecting' }
}

interface ChatInterfaceProps {
  selectedServer: MCPServer
}

export function ChatInterface({ selectedServer }: ChatInterfaceProps) {
  const [input, setInput] = useState('')
  const [isConnected, setIsConnected] = useState(false)
  const [mcpState, setMcpState] = useState<MCPServersState>({
    prompts: [],
    resources: [],
    servers: {},
    tools: [],
  })
  const [isConnectingMcp, setIsConnectingMcp] = useState(false)
  const pendingMessageRef = useRef<string | null>(null)
  const connectedRef = useRef(false)

  // Each server gets its own DO — session ID includes server ID
  const [userId] = useState(getOrCreateSessionId)
  const agentName = `${userId}-${selectedServer.id}`

  const agent = useAgent({
    agent: 'chat-agent',
    name: agentName,
    onOpen: useCallback(() => setIsConnected(true), []),
    onClose: useCallback(() => setIsConnected(false), []),
    onError: useCallback(() => setIsConnected(false), []),
    onMcpUpdate: useCallback((state: MCPServersState) => {
      setMcpState(state)
      setIsConnectingMcp(false)
    }, []),
  })

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({ agent })

  // Reset local state when server changes (new agent/DO)
  useEffect(() => {
    setInput('')
    setIsConnectingMcp(false)
    pendingMessageRef.current = null
    connectedRef.current = false
    setMcpState({ prompts: [], resources: [], servers: {}, tools: [] })
  }, [selectedServer.id])

  const isStreaming = status === 'streaming'
  const { status: mcpStatus, authUrl } = getMcpStatus(mcpState)
  const isReady = mcpStatus === 'ready'

  // Open OAuth popup when auth is needed
  useEffect(() => {
    if (mcpStatus === 'authenticating' && authUrl) {
      window.open(authUrl, 'oauth', 'width=600,height=800')
    }
  }, [mcpStatus, authUrl])

  // Send pending message when MCP becomes ready
  useEffect(() => {
    if (isReady && pendingMessageRef.current) {
      const text = pendingMessageRef.current
      pendingMessageRef.current = null
      setIsConnectingMcp(false)
      sendMessage({ role: 'user', parts: [{ type: 'text', text }] })
    }
  }, [isReady, sendMessage])

  const handleClear = useCallback(() => {
    stop()
    setIsConnectingMcp(false)
    setInput('')
    pendingMessageRef.current = null
    connectedRef.current = false
    clearHistory()
    agent.call('resetAgent', []).catch(() => {})
  }, [agent, clearHistory, stop])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || isStreaming) return

    setInput('')

    if (isReady && connectedRef.current) {
      sendMessage({ role: 'user', parts: [{ type: 'text', text }] })
      return
    }

    // Not connected yet — store message and connect
    pendingMessageRef.current = text
    setIsConnectingMcp(true)
    try {
      await agent.call('connectMcp', [selectedServer.id])
      connectedRef.current = true
    } catch (e) {
      console.error('Failed to connect MCP server:', e)
      setIsConnectingMcp(false)
      pendingMessageRef.current = null
      setInput(text)
    }
  }, [input, isStreaming, isReady, agent, sendMessage, selectedServer.id])

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  const hasPending = pendingMessageRef.current !== null

  return (
    <div className="flex flex-col h-full rounded-xl border border-(--color-border) bg-(--color-surface-secondary) overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-dashed border-(--color-border)">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isReady ? 'bg-green-500' : isConnectingMcp || mcpStatus === 'connecting' ? 'bg-amber-500' : 'bg-(--color-muted)'}`} />
          <span className="font-mono text-xs text-(--color-muted)">
            {selectedServer.name}
          </span>
          {isReady && mcpState.tools.length > 0 && (
            <span className="font-mono text-xs text-(--color-muted)">
              · {mcpState.tools.length} tools
            </span>
          )}
          {mcpStatus === 'authenticating' && (
            <span className="font-mono text-xs text-amber-500">
              · waiting for auth
            </span>
          )}
          {isConnectingMcp && mcpStatus !== 'authenticating' && (
            <span className="font-mono text-xs text-(--color-muted)">
              · connecting...
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleClear}
          disabled={messages.length === 0 && mcpStatus === 'disconnected' && !hasPending}
          className="flex items-center gap-1 text-xs text-(--color-muted) hover:text-(--color-surface) disabled:opacity-30 transition-colors cursor-pointer disabled:cursor-default"
        >
          <Trash size={14} />
          Clear
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-4 space-y-4">
          {messages.length === 0 && !hasPending && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-sm text-(--color-muted) mb-3">
                Try the {selectedServer.name} MCP server
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {(selectedServer.id === 'cloudflare'
                  ? ["What's the traffic today?", 'Make a hello world Worker', 'Protect with Access']
                  : [`What can I do with ${selectedServer.name}?`, 'List my projects', 'Show recent activity']
                ).map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="text-xs px-3 py-1.5 rounded-full border border-dashed border-(--color-border) text-(--color-label) hover:bg-(--color-subtle) hover:border-(--color-surface) transition-colors cursor-pointer"
                    onClick={() => setInput(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Show pending message while waiting for auth */}
          {hasPending && messages.length === 0 && (
            <>
              <div className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-md bg-(--btn-primary-bg) text-(--btn-primary-text) px-4 py-2.5 text-sm leading-relaxed opacity-60">
                  {pendingMessageRef.current}
                </div>
              </div>
              <div className="flex justify-start">
                <div className="flex items-center gap-2 text-xs text-(--color-muted) px-2">
                  <CircleNotch size={14} className="animate-spin" />
                  {mcpStatus === 'authenticating' ? 'Waiting for authentication...' : `Connecting to ${selectedServer.name}...`}
                </div>
              </div>
            </>
          )}

          {messages.map((message, msgIndex) => {
            const isUser = message.role === 'user'
            const isLastAssistant = message.role === 'assistant' && msgIndex === messages.length - 1
            const isAnimating = isStreaming && isLastAssistant

            if (isUser) {
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl rounded-br-md bg-(--btn-primary-bg) text-(--btn-primary-text)">
                    <Streamdown
                      className="sd-theme px-4 py-2.5 text-sm leading-relaxed **:text-(--btn-primary-text)"
                      controls={false}
                    >
                      {message.parts
                        .filter((p) => p.type === 'text')
                        .map((p) => (p.type === 'text' ? p.text : ''))
                        .join('')}
                    </Streamdown>
                  </div>
                </div>
              )
            }

            return (
              <div key={message.id} className="space-y-2">
                {message.parts.map((part, partIdx) => {
                  if (part.type === 'text') {
                    if (!part.text || part.text.trim() === '') return null
                    return (
                      <div key={partIdx} className="flex justify-start">
                        <div className="max-w-[80%] rounded-2xl rounded-bl-md border border-(--color-border)">
                          <Streamdown
                            className="sd-theme px-4 py-2.5 text-sm leading-relaxed"
                            controls={false}
                            isAnimating={isAnimating && partIdx === message.parts.length - 1}
                          >
                            {part.text}
                          </Streamdown>
                        </div>
                      </div>
                    )
                  }

                  if (part.type === 'step-start') return null
                  if (part.type === 'reasoning') return null

                  if (isToolUIPart(part)) {
                    return (
                      <div key={(part as any).toolCallId ?? partIdx} className="max-w-[80%]">
                        <ToolCard toolPart={part as any} />
                      </div>
                    )
                  }

                  return null
                })}
              </div>
            )
          })}
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-(--color-border) px-4 py-3">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
          className="flex items-end gap-2"
        >
          <textarea
            value={input}
            onChange={handleTextareaInput}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={`Ask ${selectedServer.name} anything...`}
            disabled={isStreaming || hasPending}
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-(--color-muted) disabled:opacity-50"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={stop}
              className="shrink-0 p-2 rounded-lg bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors cursor-pointer"
            >
              <Stop size={18} weight="fill" />
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim() || !isConnected || hasPending}
              className="shrink-0 p-2 rounded-lg bg-(--btn-primary-bg) text-(--btn-primary-text) disabled:opacity-30 hover:opacity-80 transition-opacity cursor-pointer disabled:cursor-default"
            >
              {hasPending ? (
                <CircleNotch size={18} className="animate-spin" />
              ) : (
                <PaperPlaneRight size={18} />
              )}
            </button>
          )}
        </form>
      </div>
    </div>
  )
}

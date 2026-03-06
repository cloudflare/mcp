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
  CaretRight,
  Brain,
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

function getMcpStatus(mcpState: MCPServersState, selectedServerIds: string[]): { status: McpStatus; authUrl?: string } {
  const servers = Object.values(mcpState.servers)
  if (servers.length === 0) return { status: 'disconnected' }

  // Check if any server is authenticating
  const authServer = servers.find((s) => s.state === 'authenticating' && s.auth_url)
  if (authServer) {
    return { status: 'authenticating', authUrl: authServer.auth_url }
  }

  // All selected servers must be ready
  const allReady = selectedServerIds.every((id) => {
    const server = servers.find((s) => s.name === id)
    return server?.state === 'ready'
  })
  if (allReady) return { status: 'ready' }

  return { status: 'connecting' }
}

interface ChatAgentState {
  useCodemode: boolean
}

interface ChatInterfaceProps {
  selectedServers: MCPServer[]
  useCodemode: boolean
  onSyncFromServer: (serverIds: string[], useCodemode: boolean) => void
}

export function ChatInterface({ selectedServers, useCodemode, onSyncFromServer }: ChatInterfaceProps) {
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
  const prevSelectionRef = useRef<string | null>(null)
  const hasSyncedRef = useRef(false)

  const [sessionId, setSessionId] = useState(getOrCreateSessionId)

  const selectedServerIds = selectedServers.map((s) => s.id)
  const selectionKey = [...selectedServerIds].sort().join(',') + `|${useCodemode}`

  // Track server state for sync — refs to avoid stale closures in callbacks
  const serverStateRef = useRef<{ serverIds: string[]; useCodemode: boolean } | null>(null)

  // Single agent — one DO for the whole session
  const agent = useAgent<ChatAgentState>({
    agent: 'chat-agent',
    name: sessionId,
    onOpen: useCallback(() => setIsConnected(true), []),
    onClose: useCallback(() => setIsConnected(false), []),
    onError: useCallback(() => setIsConnected(false), []),
    onStateUpdate: useCallback((state: ChatAgentState) => {
      serverStateRef.current = { ...serverStateRef.current!, useCodemode: state.useCodemode }
    }, []),
    onMcpUpdate: useCallback((mcpState: MCPServersState) => {
      setMcpState(mcpState)
      setIsConnectingMcp(false)

      // Sync client selection from server on first MCP state push
      if (!hasSyncedRef.current) {
        hasSyncedRef.current = true
        const serverIds = Object.values(mcpState.servers).map((s) => s.name)
        if (serverIds.length > 0) {
          const codemode = serverStateRef.current?.useCodemode ?? false
          onSyncFromServer(serverIds, codemode)
        }
      }
    }, [onSyncFromServer]),
  })

  const { messages, sendMessage, clearHistory, stop, status } = useAgentChat({ agent })

  const isStreaming = status === 'streaming'
  const { status: mcpStatus, authUrl } = getMcpStatus(mcpState, selectedServerIds)
  const isReady = mcpStatus === 'ready'

  // When selection changes, clear chat but do NOT connect (lazy connect)
  useEffect(() => {
    if (prevSelectionRef.current !== null && prevSelectionRef.current !== selectionKey) {
      stop()
      clearHistory()
      pendingMessageRef.current = null
      setIsConnectingMcp(false)
      setInput('')
      setMcpState({ prompts: [], resources: [], servers: {}, tools: [] })
    }
    prevSelectionRef.current = selectionKey
  }, [selectionKey, stop, clearHistory])

  // Open OAuth popup when auth is needed
  useEffect(() => {
    if (mcpStatus === 'authenticating' && authUrl) {
      window.open(authUrl, 'oauth', 'width=600,height=800')
    }
  }, [mcpStatus, authUrl])

  // When MCP becomes ready, send any pending message
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
    // Generate new session ID → useAgent reconnects to a fresh DO
    const newId = crypto.randomUUID()
    localStorage.setItem(SESSION_KEY, newId)
    clearHistory()
    setSessionId(newId)
    setIsConnectingMcp(false)
    setInput('')
    pendingMessageRef.current = null
    prevSelectionRef.current = null
    hasSyncedRef.current = false
    setMcpState({ prompts: [], resources: [], servers: {}, tools: [] })
  }, [clearHistory, stop])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || isStreaming) return

    setInput('')

    if (isReady) {
      // Already connected — send immediately
      sendMessage({ role: 'user', parts: [{ type: 'text', text }] })
      return
    }

    // Not connected — store message and kick off connection
    pendingMessageRef.current = text
    setIsConnectingMcp(true)
    try {
      await agent.call('connectServers', [selectedServerIds, useCodemode])
    } catch (e) {
      console.error('Failed to connect MCP servers:', e)
      setIsConnectingMcp(false)
      pendingMessageRef.current = null
      setInput(text)
    }
  }, [input, isStreaming, isReady, agent, sendMessage, selectedServerIds, useCodemode])

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }

  const hasPending = pendingMessageRef.current !== null
  const serverNames = selectedServers.map((s) => s.name).join(', ')

  return (
    <div className="flex flex-col h-full rounded-xl border border-(--color-border) bg-(--color-surface-secondary) overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-dashed border-(--color-border)">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isReady ? 'bg-green-500' : isConnectingMcp || mcpStatus === 'connecting' ? 'bg-amber-500' : 'bg-(--color-muted)'}`} />
          <span className="text-xs text-(--color-muted)">
            {serverNames}
          </span>
          {useCodemode && (
            <span className="text-xs text-purple-500">
              · code mode
            </span>
          )}
          {isReady && mcpState.tools.length > 0 && (
            <span className="text-xs text-(--color-muted)">
              · {mcpState.tools.length} tools
            </span>
          )}
          {mcpStatus === 'authenticating' && (
            <span className="text-xs text-amber-500">
              · waiting for auth
            </span>
          )}
          {isConnectingMcp && mcpStatus !== 'authenticating' && (
            <span className="text-xs text-(--color-muted)">
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
                {selectedServers.length === 1
                  ? `Try the ${selectedServers[0].name} MCP server`
                  : `Try ${serverNames} together`}
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {(selectedServers.length === 1 && selectedServers[0].id === 'cloudflare'
                  ? ["What's the traffic today?", 'Make a hello world Worker', 'Protect with Access']
                  : selectedServers.length === 1
                    ? [`What can I do with ${selectedServers[0].name}?`, 'List my projects', 'Show recent activity']
                    : [`What can I do across ${serverNames}?`, 'Show me an overview', 'List everything available']
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
                  {mcpStatus === 'authenticating' ? 'Waiting for authentication...' : `Connecting to ${serverNames}...`}
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
                  const partKey = partIdx

                  if (part.type === 'text') {
                    if (!part.text || part.text.trim() === '') return null
                    return (
                      <div key={partKey} className="flex justify-start">
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

                  if (part.type === 'reasoning') {
                    const text = (part as any).text
                    if (!text || text.trim() === '') return null
                    return (
                      <details key={partKey} className="max-w-[80%] group">
                        <summary className="flex items-center gap-1.5 cursor-pointer text-xs text-(--color-muted) py-1 select-none">
                          <CaretRight size={10} className="transition-transform group-open:rotate-90" />
                          <Brain size={12} />
                          Thinking
                        </summary>
                        <div className="rounded-xl border border-dashed border-(--color-border) px-3 py-2 mt-1 text-xs text-(--color-muted) italic leading-relaxed opacity-70">
                          {text}
                        </div>
                      </details>
                    )
                  }

                  if (isToolUIPart(part)) {
                    return (
                      <div key={partKey} className="max-w-[80%]">
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
            placeholder={selectedServers.length === 1 ? `Ask ${selectedServers[0].name} anything...` : `Ask ${serverNames} anything...`}
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

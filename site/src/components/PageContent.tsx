import { useState, useCallback, useRef } from 'react'
import { Scene } from '@/components/Hero'
import { FadeInSection, GlowHeading } from '@/components/GlowHeading'
import { PillLink } from '@/components/ui'
import { ChatDemo } from '@/components/chat'
import { MCP_SERVERS, type MCPServer } from '@/components/Hero/mcpServers'

export function PageContent() {
  const [selectedServers, setSelectedServers] = useState<MCPServer[]>([MCP_SERVERS[0]])
  const [codemodeEnabled, setCodemodeEnabled] = useState(false)
  const demoSectionRef = useRef<HTMLDivElement>(null)

  const useCodemode = codemodeEnabled || selectedServers.length > 1

  const handleCardClick = useCallback((server: MCPServer) => {
    setSelectedServers((prev) => {
      const exists = prev.some((s) => s.id === server.id)
      if (exists) {
        // Don't allow deselecting the last server
        if (prev.length === 1) return prev
        return prev.filter((s) => s.id !== server.id)
      }
      return [...prev, server]
    })
    demoSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  return (
    <div className="flex flex-col">
      {/* Hero */}
      <div className="h-[30vh] sm:h-[35vh] md:h-[45vh] lg:h-[50vh]">
        <Scene onCardClick={handleCardClick} selectedServerId={selectedServers[0]?.id} />
      </div>

      {/* Try it — Chat Demo */}
      <div ref={demoSectionRef}>
        <FadeInSection
          className="border-t border-dashed border-(--color-border) px-4 py-12 sm:px-6 sm:py-16"
          cornerGrid={{ position: 'bottom-right', color: '#f38020' }}
        >
          <div className="mx-auto max-w-3xl">
            <GlowHeading eyebrow="Try it">
              Build and connect to MCP servers.
            </GlowHeading>
            <p className="text-lg leading-relaxed text-(--color-label) mb-6">
              Host your MCP servers on Cloudflare. Join the likes of these companies.
            </p>
            <div className="flex flex-wrap gap-2 mb-6">
              {MCP_SERVERS.map((server) => {
                const Icon = server.icon
                const isActive = selectedServers.some((s) => s.id === server.id)
                return (
                  <button
                    key={server.id}
                    type="button"
                    onClick={() => handleCardClick(server)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all cursor-pointer ${
                      isActive
                        ? 'border-current bg-(--color-subtle)'
                        : 'border-dashed border-(--color-border) text-(--color-label) hover:bg-(--color-subtle) hover:border-(--color-surface)'
                    }`}
                    style={isActive ? { color: server.darkColor ?? server.color } : undefined}
                  >
                    <Icon size={14} />
                    {server.name}
                  </button>
                )
              })}
              {/* Code Mode pill */}
              <button
                type="button"
                onClick={() => {
                  if (selectedServers.length <= 1) setCodemodeEnabled((v) => !v)
                }}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                  useCodemode
                    ? 'border-purple-500 bg-purple-500/10 text-purple-500'
                    : 'border-dashed border-(--color-border) text-(--color-label) hover:bg-(--color-subtle) hover:border-(--color-surface) cursor-pointer'
                } ${selectedServers.length > 1 ? 'cursor-default' : 'cursor-pointer'}`}
                title={selectedServers.length > 1 ? 'Code Mode is always active with multiple servers' : 'Toggle Code Mode'}
              >
                {'</>'}
                Code Mode
                {selectedServers.length > 1 && (
                  <span className="text-[10px] opacity-70">auto</span>
                )}
              </button>
            </div>
            <ChatDemo selectedServers={selectedServers} useCodemode={useCodemode} />
          </div>
        </FadeInSection>
      </div>

      {/* Features */}
      <FadeInSection
        className="border-t border-dashed border-(--color-border) px-4 py-16 sm:px-6 sm:py-24"
        cornerGrid={{ position: 'top-left', color: '#6366f1' }}
      >
        <div className="mx-auto max-w-3xl">
          <GlowHeading eyebrow="Features">
            Spec compliant MCP servers at global scale.
          </GlowHeading>
          <p className="text-lg leading-relaxed text-(--color-label) mb-10">
            Host stateful or stateless MCP servers at global scale — fast cold starts, automatic scaling, and zero infrastructure to manage.
          </p>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="rounded-lg border border-dashed border-(--color-border) p-5">
              <h3 className="font-medium mb-2">MCP Client in Agents SDK</h3>
              <p className="text-sm text-(--color-label) leading-relaxed">
                The{' '}
                <a href="https://developers.cloudflare.com/agents/" className="underline hover:text-(--color-surface)">
                  Agents SDK
                </a>
                {' '}includes a built-in MCP client. Connect to any MCP server from your agent with a single method call.
              </p>
            </div>
            <div className="rounded-lg border border-dashed border-(--color-border) p-5">
              <h3 className="font-medium mb-2">Authentication</h3>
              <p className="text-sm text-(--color-label) leading-relaxed">
                Add OAuth to your servers with{' '}
                <a href="https://github.com/cloudflare/workers-oauth-provider" className="underline hover:text-(--color-surface)">
                  Workers OAuth Provider
                </a>
                . Users authorize with their existing accounts — no API keys needed.
              </p>
            </div>
            <div className="rounded-lg border border-dashed border-(--color-border) p-5">
              <h3 className="font-medium mb-2">Code Mode</h3>
              <p className="text-sm text-(--color-label) leading-relaxed">
                Execute untrusted code in sandboxed{' '}
                <a href="https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/" className="underline hover:text-(--color-surface)">
                  Dynamic Worker
                </a>
                {' '}isolates. LLMs write code against your API instead of calling thousands of tools.
              </p>
            </div>
            <div className="rounded-lg border border-dashed border-(--color-border) p-5">
              <h3 className="font-medium mb-2">Region: Earth</h3>
              <p className="text-sm text-(--color-label) leading-relaxed">
                Host MCP servers on Workers — global by default across 300+ locations. Only pay for CPU time, not wall time.
              </p>
            </div>
          </div>
        </div>
      </FadeInSection>

      {/* MCP Spec Features */}
      <FadeInSection
        className="border-t border-dashed border-(--color-border) px-4 py-16 sm:px-6 sm:py-24"
        cornerGrid={{ position: 'top-right', color: '#a855f7' }}
      >
        <div className="mx-auto max-w-3xl">
          <GlowHeading eyebrow="MCP Spec">
            Full protocol support, day one.
          </GlowHeading>
          <p className="text-lg leading-relaxed text-(--color-label) mb-10">
            Cloudflare's MCP implementation tracks the{' '}
            <a href="https://modelcontextprotocol.io" className="underline hover:text-(--color-surface)">
              latest spec
            </a>
            . Every feature ships as soon as it's standardized.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { title: 'Streamable HTTP', desc: 'Bi-directional JSON-RPC over HTTP. No SSE, no WebSockets required. Production-ready transport.' },
              { title: 'OAuth 2.1', desc: 'Full spec authorization via Workers OAuth Provider — PKCE, Protected Resource Metadata discovery, and Client ID Metadata Document.' },
              { title: 'Elicitations', desc: 'Servers request additional context from users mid-conversation. Define schemas for exactly what input you need.' },
              { title: 'Sampling', desc: 'Server-initiated LLM calls for agentic workflows. Clients control approval, prompts, and visibility.' },
              { title: 'Tasks', desc: 'Use Cloudflare Workflows for durable execution, status updates, and structured results across long-running operations.' },
              { title: 'Tool Output Schemas', desc: 'Clients and LLMs understand tool output shapes ahead of time for more reliable integrations.' },
            ].map((item) => (
              <div key={item.title} className="rounded-lg border border-dashed border-(--color-border) p-4">
                <h3 className="font-medium text-sm mb-1.5">{item.title}</h3>
                <p className="text-xs text-(--color-label) leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </FadeInSection>

      {/* CTA */}
      <FadeInSection
        className="border-t border-dashed border-(--color-border) px-4 py-16 sm:px-6 sm:py-24"
        cornerGrid={{ position: 'bottom-left', color: '#6366f1' }}
      >
        <div className="mx-auto max-w-3xl text-center">
          <GlowHeading eyebrow="Get started">Build your own MCP server</GlowHeading>
          <p className="text-lg leading-relaxed text-(--color-label)">
            Deploy a remote MCP server on Cloudflare in minutes. Read the blog post, follow the guide, or explore the source.
          </p>
          <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <PillLink href="https://developers.cloudflare.com/agents/guides/remote-mcp-server/" variant="primary">
              Deploy an MCP server
            </PillLink>
            <PillLink href="https://blog.cloudflare.com/code-mode-mcp/" variant="secondary">
              Code Mode
            </PillLink>
            <PillLink href="https://github.com/cloudflare/mcp" variant="secondary">
              View source
            </PillLink>
          </div>
        </div>
      </FadeInSection>

      {/* Footer */}
      <footer className="border-t border-(--color-border) bg-(--color-surface-secondary)">
        <div className="mx-auto flex max-w-[var(--max-width)] items-center justify-between border-x border-dashed border-(--color-border) px-4 py-6 sm:px-6">
          <p className="font-mono text-xs text-(--color-muted)">&copy; 2026 Cloudflare, Inc.</p>
          <div className="flex gap-6">
            <a
              href="https://cloudflare.com/privacy"
              className="font-mono text-xs text-(--color-muted) hover:text-(--color-surface)"
            >
              Privacy
            </a>
            <a
              href="https://cloudflare.com/terms"
              className="font-mono text-xs text-(--color-muted) hover:text-(--color-surface)"
            >
              Terms
            </a>
            <a
              href="https://cloudflarestatus.com"
              className="font-mono text-xs text-(--color-muted) hover:text-(--color-surface)"
            >
              Status
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}

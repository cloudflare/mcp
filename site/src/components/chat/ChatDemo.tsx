import { ChatInterface } from './ChatInterface'
import type { MCPServer } from '@/components/Hero/mcpServers'

interface ChatDemoProps {
  selectedServer: MCPServer
}

export function ChatDemo({ selectedServer }: ChatDemoProps) {
  return (
    <div className="h-[65vh] min-h-[450px]">
      <ChatInterface selectedServer={selectedServer} />
    </div>
  )
}

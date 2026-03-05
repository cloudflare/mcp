import { ChatInterface } from './ChatInterface'
import type { MCPServer } from '@/components/Hero/mcpServers'

interface ChatDemoProps {
  selectedServers: MCPServer[]
  useCodemode: boolean
}

export function ChatDemo({ selectedServers, useCodemode }: ChatDemoProps) {
  return (
    <div className="h-[65vh] min-h-[450px]">
      <ChatInterface selectedServers={selectedServers} useCodemode={useCodemode} />
    </div>
  )
}

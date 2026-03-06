import { ChatInterface } from './ChatInterface'
import type { MCPServer } from '@/components/Hero/mcpServers'

interface ChatDemoProps {
  selectedServers: MCPServer[]
  useCodemode: boolean
  onSyncFromServer: (serverIds: string[], useCodemode: boolean) => void
}

export function ChatDemo({ selectedServers, useCodemode, onSyncFromServer }: ChatDemoProps) {
  return (
    <div className="h-[65vh] min-h-[450px]">
      <ChatInterface selectedServers={selectedServers} useCodemode={useCodemode} onSyncFromServer={onSyncFromServer} />
    </div>
  )
}

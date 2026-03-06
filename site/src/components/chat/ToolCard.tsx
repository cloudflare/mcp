import { useState } from 'react'
import {
  CaretRight,
  Lightning,
  Code,
  CheckCircle,
  WarningCircle,
  CircleNotch,
} from '@phosphor-icons/react'

interface ToolPart {
  type: string
  toolCallId?: string
  toolName?: string
  state?: string
  errorText?: string
  input?: { code?: string; [key: string]: unknown }
  output?: unknown
}

function formatOutput(output: unknown): string {
  if (typeof output === 'string') return output
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

export function ToolCard({ toolPart }: { toolPart: ToolPart }) {
  const [expanded, setExpanded] = useState(false)
  const hasError = toolPart.state === 'output-error' || !!toolPart.errorText
  const isComplete = toolPart.state === 'output-available'
  const isRunning = !isComplete && !hasError

  // Extract a readable tool name from the MCP tool key
  // Format: "tool_<serverId>_<toolName>" e.g. "tool_aL4Y1Ql4_search"
  const rawName = toolPart.toolName || (toolPart as any).name || ''
  const isCodemode = rawName === 'codemode'
  const toolNameMatch = rawName.match(/^tool_[a-zA-Z0-9]+_(.+)$/)
  const label = isCodemode
    ? 'Code'
    : toolNameMatch
      ? toolNameMatch[1]
      : rawName || 'Tool call'
  const Icon = isCodemode ? Code : Lightning

  // For codemode, output may contain { result, logs }
  const outputObj = toolPart.output as any
  const codemodeResult = isCodemode && outputObj?.result !== undefined ? formatOutput(outputObj.result) : undefined
  const codemodeLogs = isCodemode && Array.isArray(outputObj?.logs) && outputObj.logs.length > 0 ? outputObj.logs as string[] : undefined
  const outputStr = isCodemode ? codemodeResult : (toolPart.output ? formatOutput(toolPart.output) : undefined)

  return (
    <div
      className={`rounded-xl border overflow-hidden ${hasError ? 'border-red-500/40' : 'border-(--color-border)'}`}
    >
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-(--color-subtle) transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <CaretRight
          size={12}
          className={`text-(--color-muted) transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <Icon size={14} className="text-(--color-muted)" />
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="text-xs font-medium">{label}</span>
        </div>
        {isComplete && <CheckCircle size={14} weight="fill" className="text-green-500 shrink-0" />}
        {hasError && <WarningCircle size={14} weight="fill" className="text-red-500 shrink-0" />}
        {isRunning && <CircleNotch size={14} className="text-(--color-muted) animate-spin shrink-0" />}
      </button>

      <div
        className={`transition-all duration-200 overflow-hidden ${
          expanded ? 'max-h-[600px] opacity-100' : 'max-h-0 opacity-0'
        }`}
      >
        <div className="px-3 pb-3 border-t border-(--color-border) space-y-2 pt-2">
          {toolPart.input?.code && (
            <div>
              <div className="flex items-center gap-1 mb-1">
                <Code size={10} className="text-(--color-muted)" />
                <span className="text-xs font-medium text-(--color-label)">Code</span>
              </div>
              <pre className="font-mono text-xs text-(--color-label) bg-(--color-subtle) rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
                {toolPart.input.code}
              </pre>
            </div>
          )}
          {!toolPart.input?.code && toolPart.input && (
            <div>
              <span className="text-xs font-medium text-(--color-label)">Input</span>
              <pre className="font-mono text-xs text-(--color-label) bg-(--color-subtle) rounded p-2 overflow-x-auto whitespace-pre-wrap mt-1">
                {JSON.stringify(toolPart.input, null, 2)}
              </pre>
            </div>
          )}
          {outputStr !== undefined && (
            <div>
              <span className="text-xs font-medium text-(--color-label)">Result</span>
              <pre className="font-mono text-xs text-(--color-label) bg-green-500/5 border border-green-500/20 rounded p-2 overflow-x-auto whitespace-pre-wrap mt-1 max-h-64 overflow-y-auto">
                {outputStr}
              </pre>
            </div>
          )}
          {codemodeLogs && (
            <div>
              <span className="text-xs font-medium text-(--color-label)">Logs</span>
              <pre className="font-mono text-xs text-(--color-muted) bg-(--color-subtle) rounded p-2 overflow-x-auto whitespace-pre-wrap mt-1 max-h-32 overflow-y-auto">
                {codemodeLogs.join('\n')}
              </pre>
            </div>
          )}
          {toolPart.errorText && (
            <div>
              <span className="text-xs font-medium text-(--color-label)">Error</span>
              <pre className="font-mono text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2 overflow-x-auto whitespace-pre-wrap mt-1">
                {toolPart.errorText}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { CodeBlock } from './CodeBlock'

interface Tab {
  label: string
  title: string
  language?: 'typescript' | 'javascript' | 'json' | 'bash' | 'text'
  code: string
}

interface TabbedCodeBlockProps {
  tabs: Tab[]
}

export function TabbedCodeBlock({ tabs }: TabbedCodeBlockProps) {
  const [active, setActive] = useState(0)
  const current = tabs[active]

  return (
    <div>
      <div className="flex gap-1 border-b border-(--color-border) pb-0">
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            type="button"
            onClick={() => setActive(i)}
            className={`rounded-t-md px-3 py-1.5 font-mono text-xs transition-colors ${
              i === active
                ? 'bg-(--color-subtle) text-(--color-surface) border border-b-0 border-(--color-border)'
                : 'text-(--color-muted) hover:text-(--color-surface)'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <CodeBlock title={current.title} language={current.language ?? 'typescript'}>
        {current.code}
      </CodeBlock>
    </div>
  )
}

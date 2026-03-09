import { useEffect, useState, useCallback } from 'react'
import { codeToHtml } from 'shiki'
import { Copy, Check } from '@phosphor-icons/react'

interface ShikiCodeProps {
  code: string
  lang?: string
}

function isDark() {
  return document.documentElement.getAttribute('data-mode') === 'dark'
}

export function ShikiCode({ code, lang = 'typescript' }: ShikiCodeProps) {
  const [html, setHtml] = useState<string | null>(null)
  const [dark, setDark] = useState(isDark)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isDark()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    codeToHtml(code, {
      lang,
      theme: dark ? 'github-dark-default' : 'github-light-default',
    }).then(setHtml)
  }, [code, lang, dark])

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [code])

  if (!html) {
    return (
      <pre className="p-4 text-xs font-mono leading-relaxed overflow-x-auto text-(--color-label)">
        {code}
      </pre>
    )
  }

  return (
    <div className="relative group">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer bg-(--color-subtle) hover:bg-(--color-border) text-(--color-muted) hover:text-(--color-surface)"
        title="Copy code"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <div
        className="shiki-wrapper text-xs leading-relaxed overflow-x-auto [&_pre]:!bg-transparent [&_pre]:p-4 [&_pre]:m-0 [&_code]:!text-xs [&_code]:!leading-relaxed"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}

import { useEffect, useState } from 'react'
import { codeToHtml } from 'shiki'

interface ShikiCodeProps {
  code: string
  lang?: string
}

export function ShikiCode({ code, lang = 'typescript' }: ShikiCodeProps) {
  const [html, setHtml] = useState<string | null>(null)

  useEffect(() => {
    codeToHtml(code, {
      lang,
      theme: 'github-dark-default',
    }).then(setHtml)
  }, [code, lang])

  if (!html) {
    // Fallback while loading
    return (
      <pre className="p-4 text-xs font-mono leading-relaxed overflow-x-auto text-(--color-label)">
        {code}
      </pre>
    )
  }

  return (
    <div
      className="shiki-wrapper text-xs leading-relaxed overflow-x-auto [&_pre]:!bg-transparent [&_pre]:p-4 [&_pre]:m-0 [&_code]:!text-xs [&_code]:!leading-relaxed"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

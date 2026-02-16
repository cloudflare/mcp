import { useState, useCallback } from 'react'
import { CornerMarks } from './CornerMarks'

interface CodeBlockProps {
  children: string
  title?: string
  language?: 'typescript' | 'javascript' | 'json' | 'bash' | 'text'
  showLineNumbers?: boolean
}

/**
 * Enhanced code block with terminal chrome, corner marks, and syntax highlighting.
 * Uses CSS-based highlighting for common patterns (strings, comments, keywords).
 */
export function CodeBlock({
  children,
  title,
  language = 'typescript',
  showLineNumbers = false
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  // Ensure children is a string
  const codeString = typeof children === 'string' ? children : String(children || '')

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(codeString)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [codeString])

  const highlightedCode = highlightSyntax(codeString, language)
  const lines = highlightedCode.split('\n')

  return (
    <div className="group relative">
      {/* Corner marks */}
      <CornerMarks />

      <div className="overflow-hidden rounded-lg border border-(--color-border) bg-(--color-subtle)">
        {/* Terminal header */}
        {title && (
          <div className="flex items-center justify-between border-b border-(--color-border) px-4 py-2">
            <div className="flex items-center gap-3">
              {/* Window dots */}
              <div className="flex gap-1.5">
                <div className="h-3 w-3 rounded-full bg-red-400/60" />
                <div className="h-3 w-3 rounded-full bg-yellow-400/60" />
                <div className="h-3 w-3 rounded-full bg-green-400/60" />
              </div>
              <span className="font-mono text-xs text-(--color-muted)">{title}</span>
            </div>

            {/* Copy button */}
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1 rounded border border-transparent px-2 py-1 font-mono text-xs text-(--color-muted) transition-colors hover:border-(--color-border) hover:text-(--color-surface)"
              aria-label="Copy code"
            >
              {copied ? (
                <>
                  <CheckIcon />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <CopyIcon />
                  <span>Copy</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* Code content */}
        <pre className="overflow-x-auto p-4">
          <code className="font-mono text-sm leading-relaxed">
            {showLineNumbers ? (
              <table className="w-full border-collapse">
                <tbody>
                  {lines.map((line, i) => (
                    <tr key={`line-${i}-${line.slice(0, 10)}`}>
                      <td className="select-none pr-4 text-right text-(--color-muted) opacity-50">
                        {i + 1}
                      </td>
                      <td
                        className="whitespace-pre"
                        dangerouslySetInnerHTML={{ __html: line || ' ' }}
                      />
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <span dangerouslySetInnerHTML={{ __html: highlightedCode }} />
            )}
          </code>
        </pre>
      </div>
    </div>
  )
}

/**
 * Single-pass syntax highlighter. Tokenizes raw code so each region
 * (string, comment, keyword) is captured exactly once — no cascading
 * regex replacements that break each other's HTML.
 */
function highlightSyntax(
  code: string,
  language: 'typescript' | 'javascript' | 'json' | 'bash' | 'text'
): string {
  if (language === 'text') return escapeHtml(code)
  if (language === 'json') return highlightJson(code)

  const keywordSet = new Set([
    'import','export','from','const','let','var','function','async','await',
    'return','if','else','for','while','class','interface','type','extends',
    'implements','new','this','try','catch','throw','default',
  ])

  // Single regex: comments | strings | template literals | words
  const tokenRegex =
    /(\/\/.*$|\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(`(?:[^`\\]|\\.)*`)|(\b[a-zA-Z_]\w*\b)/gm

  let result = ''
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenRegex.exec(code)) !== null) {
    // Escaped text between tokens
    result += escapeHtml(code.slice(lastIndex, match.index))
    const [full, comment, string, template, word] = match

    if (comment) {
      result += `<span class="syntax-comment">${escapeHtml(comment)}</span>`
    } else if (string) {
      result += `<span class="syntax-string">${escapeHtml(string)}</span>`
    } else if (template) {
      result += `<span class="syntax-string">${escapeHtml(template)}</span>`
    } else if (word && keywordSet.has(word)) {
      result += `<span class="syntax-keyword">${escapeHtml(word)}</span>`
    } else {
      result += escapeHtml(full)
    }
    lastIndex = match.index + full.length
  }

  result += escapeHtml(code.slice(lastIndex))
  return result
}

function highlightJson(code: string): string {
  // For JSON: highlight keys and string values
  const tokenRegex = /("(?:[^"\\]|\\.)*")\s*(:)?/g
  let result = ''
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenRegex.exec(code)) !== null) {
    result += escapeHtml(code.slice(lastIndex, match.index))
    const [full, str, colon] = match
    if (colon) {
      // It's a key
      result += `<span class="syntax-keyword">${escapeHtml(str)}</span>${escapeHtml(colon)}`
    } else {
      result += `<span class="syntax-string">${escapeHtml(str)}</span>`
    }
    lastIndex = match.index + full.length
  }

  result += escapeHtml(code.slice(lastIndex))
  return result
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <title>Copy</title>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <title>Copied</title>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

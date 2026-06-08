import { describe, it, expect, vi } from 'vitest'
import { extractTitle, formatDocsResults, queryCloudflareDocs, sourceToUrl } from '../docs-search'

describe('docs search', () => {
  function makeAi(response: unknown): { ai: Ai; search: ReturnType<typeof vi.fn> } {
    const search = vi.fn().mockResolvedValue(response)
    return {
      ai: {
        autorag: vi.fn(() => ({ search }))
      } as any,
      search
    }
  }

  const aiSearchResponse = {
    object: 'vector_store.search_results.page',
    search_query: 'workers kv binding example',
    data: [
      {
        file_id: 'file-1',
        filename: 'workers/runtime-apis/kv/index.md',
        score: 0.93,
        attributes: {},
        content: [
          { id: 'chunk-1', type: 'text', text: 'Create a KV namespace.' },
          { id: 'chunk-2', type: 'text', text: 'Bind it to your Worker.' }
        ]
      }
    ],
    has_more: false,
    next_page: null
  }

  it('queries the docs AI Search AutoRAG and maps results', async () => {
    const { ai, search } = makeAi(aiSearchResponse)

    const results = await queryCloudflareDocs(ai, 'workers kv binding example')

    expect(ai.autorag).toHaveBeenCalledWith('docs-mcp-rag')
    expect(search).toHaveBeenCalledWith({
      query: 'workers kv binding example'
    })
    expect(results).toEqual([
      {
        similarity: 0.93,
        id: 'file-1',
        url: 'https://developers.cloudflare.com/workers/runtime-apis/kv/',
        title: 'Kv',
        text: 'Create a KV namespace.\nBind it to your Worker.'
      }
    ])
  })

  it('formats unstructured content as documentation result blocks', () => {
    expect(
      formatDocsResults([
        {
          similarity: 0.93,
          id: 'file-1',
          url: 'https://developers.cloudflare.com/workers/runtime-apis/kv/',
          title: 'KV',
          text: 'Create a KV namespace.'
        }
      ])
    ).toBe(`<result>
<url>https://developers.cloudflare.com/workers/runtime-apis/kv/</url>
<title>KV</title>
<text>
Create a KV namespace.
</text>
</result>`)
  })

  it('turns docs filenames into developer docs URLs', () => {
    expect(sourceToUrl('workers/configuration/index.md')).toBe(
      'https://developers.cloudflare.com/workers/configuration/'
    )
    expect(sourceToUrl('workers/configuration/compatibility-dates.mdx')).toBe(
      'https://developers.cloudflare.com/workers/configuration/compatibility-dates'
    )
  })

  it('does not double-prefix full documentation URLs', () => {
    expect(sourceToUrl('https://developers.cloudflare.com/r2/api/workers/')).toBe(
      'https://developers.cloudflare.com/r2/api/workers/'
    )
  })

  it('extracts titles from filenames and URLs', () => {
    expect(extractTitle('workers/configuration/index.md')).toBe('Configuration')
    expect(extractTitle('workers/configuration/compatibility-dates.mdx')).toBe(
      'Compatibility Dates'
    )
    expect(extractTitle('https://developers.cloudflare.com/r2/api/workers/')).toBe('Workers')
  })
})

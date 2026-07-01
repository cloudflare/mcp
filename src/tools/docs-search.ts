import { z } from 'zod'
import { env } from 'cloudflare:workers'
import type { McpServer, Tool } from '@modelcontextprotocol/server'
import { formatError } from '../utils/errors'

const AiSearchResponseSchema = z.object({
  object: z.string(),
  search_query: z.string(),
  data: z.array(
    z.object({
      file_id: z.string(),
      filename: z.string(),
      score: z.number(),
      attributes: z
        .object({
          modified_date: z.number().optional(),
          folder: z.string().optional()
        })
        .catchall(z.any()),
      content: z.array(
        z.object({
          id: z.string(),
          type: z.string(),
          text: z.string()
        })
      )
    })
  ),
  has_more: z.boolean(),
  next_page: z.string().nullable()
})

type DocsSearchResult = {
  similarity: number
  id: string
  url: string
  title: string
  text: string
}

type DocsSearchOutput = {
  results: DocsSearchResult[]
}

export const docsToolDescription = `Search the Cloudflare documentation.

		This tool should be used to answer any question about Cloudflare products or features, including:
		- Workers, Pages, R2, Images, Stream, D1, Durable Objects, KV, Workflows, Hyperdrive, Queues
		- AI Search, Workers AI, Vectorize, AI Gateway, Browser Rendering
		- Zero Trust, Access, Tunnel, Gateway, Browser Isolation, WARP, DDOS, Magic Transit, Magic WAN
		- CDN, Cache, DNS, Zaraz, Argo, Rulesets, Terraform, Account and Billing

		Results are returned as semantically similar chunks to the query.
		`

/** Wire-format definition used by the precomputed non-Code-Mode tools/list. */
export const DOCS_TOOL: Tool = {
  name: 'docs',
  description: docsToolDescription,
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Cloudflare documentation search query' }
    },
    required: ['query']
  },
  outputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            similarity: { type: 'number', description: 'Similarity score from AI Search' },
            id: { type: 'string', description: 'Source file ID' },
            url: { type: 'string', description: 'Developer documentation URL' },
            title: { type: 'string', description: 'Documentation page title' },
            text: { type: 'string', description: 'Matching documentation chunk text' }
          },
          required: ['similarity', 'id', 'url', 'title', 'text'],
          additionalProperties: false
        }
      }
    },
    required: ['results'],
    additionalProperties: false
  },
  annotations: { readOnlyHint: true }
}

export async function runDocsTool(query: string) {
  if (!env.AI) {
    return formatError('Cloudflare docs search is not configured in this environment.')
  }

  const structuredContent: DocsSearchOutput = {
    results: await queryCloudflareDocs(env.AI, query)
  }
  return {
    content: [{ type: 'text' as const, text: formatDocsResults(structuredContent.results) }],
    structuredContent
  }
}

export function registerDocsTool(server: McpServer) {
  server.registerTool(
    'docs',
    {
      description: docsToolDescription,
      inputSchema: z.object({
        query: z.string().describe('Cloudflare documentation search query')
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            similarity: z.number().describe('Similarity score from AI Search'),
            id: z.string().describe('Source file ID'),
            url: z.string().describe('Developer documentation URL'),
            title: z.string().describe('Documentation page title'),
            text: z.string().describe('Matching documentation chunk text')
          })
        )
      }),
      annotations: {
        readOnlyHint: true
      }
    },
    ({ query }) => runDocsTool(query)
  )
}

export async function queryCloudflareDocs(ai: Ai, query: string): Promise<DocsSearchResult[]> {
  const rawResponse = await doWithRetries(() =>
    ai.autorag('docs-mcp-rag').search({
      query
    })
  )

  const response = AiSearchResponseSchema.parse(rawResponse)

  return response.data.map((item) => ({
    similarity: item.score,
    id: item.file_id,
    url: sourceToUrl(item.filename),
    title: extractTitle(item.filename),
    text: item.content.map((content) => content.text).join('\n')
  }))
}

export function formatDocsResults(results: DocsSearchResult[]): string {
  return results
    .map(
      (result) => `<result>
<url>${result.url}</url>
<title>${result.title}</title>
<text>
${result.text}
</text>
</result>`
    )
    .join('\n')
}

export function sourceToUrl(filename: string): string {
  if (filename.startsWith('https://') || filename.startsWith('http://')) {
    return filename
  }

  return (
    'https://developers.cloudflare.com/' +
    filename.replace(/index\.mdx?$/, '').replace(/\.mdx?$/, '')
  )
}

export function extractTitle(filename: string): string {
  const urlPath =
    filename.startsWith('https://') || filename.startsWith('http://')
      ? new URL(filename).pathname
      : filename
  const parts = urlPath
    .replace(/\/$/, '')
    .replace(/\.mdx?$/, '')
    .split('/')
  const lastPart = parts[parts.length - 1]

  if (lastPart === 'index') {
    return titleCase(parts[parts.length - 2] || 'Documentation')
  }

  return titleCase(lastPart || 'Documentation')
}

async function doWithRetries<T>(action: () => Promise<T>): Promise<T> {
  const maxRetries = 5
  const initialRetryMs = 100

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await action()
    } catch (error) {
      console.error(`AI Search attempt ${attempt + 1} failed:`, error)

      if (!isRetryableError(error) || attempt === maxRetries) {
        throw error
      }

      await scheduler.wait(initialRetryMs * Math.pow(2, attempt))
    }
  }

  throw new Error('An unknown error occurred')
}

function isRetryableError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status
    return status >= 500 || status === 429
  }

  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    return (
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('connection') ||
      message.includes('fetch')
    )
  }

  return true
}

function titleCase(value: string): string {
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

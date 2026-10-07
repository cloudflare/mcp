import type { ForgeOpenApiDocument } from '@cloudflare/forge'
import type { ArtifactKey, McpToolsArtifact } from '../../src/mcp-tools.ts'
import { generateMcpTools } from './mcp.ts'
import { processSpec } from './spec.ts'

export interface Artifacts {
  files: Record<ArtifactKey, string>
  tools: number
  products: number
}

/** Everything the Worker reads, generated from one Forge document. */
export async function buildArtifacts(source: ForgeOpenApiDocument): Promise<Artifacts> {
  const { spec, products } = processSpec(source as unknown as Record<string, unknown>)
  const [file] = await generateMcpTools(source)
  if (!file) throw new Error('Generator emitted no mcp-tools.json')
  const { tools } = JSON.parse(file.content) as McpToolsArtifact
  if (!tools.length) throw new Error('Generator emitted no tools')
  if (!products.length) throw new Error('Forge document has no products')

  return {
    files: {
      'spec.json': JSON.stringify(spec),
      'products.json': JSON.stringify(products),
      'mcp-tools.json': file.content
    },
    tools: tools.length,
    products: products.length
  }
}

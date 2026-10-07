import type { ForgeOpenApiDocument } from '@cloudflare/forge'
import type { ArtifactKey, McpToolsArtifact } from '../../src/mcp-tools.ts'
import { generateMcpTools } from './mcp.ts'
import { processSpec } from './spec.ts'
import { applyOverlay, type Overlay } from './overlay.ts'
import mcpOverlay from './overlays/mcp.overlay.json' with { type: 'json' }

export interface Artifacts {
  files: Record<ArtifactKey, string>
  tools: number
  products: number
}

/** Everything the Worker reads, generated from one Forge document. */
export async function buildArtifacts(
  forge: ForgeOpenApiDocument,
  overlays: readonly Overlay[] = [mcpOverlay as Overlay]
): Promise<Artifacts> {
  // Our fixes to Forge's document (overlays/), applied before anything is generated.
  const source = overlays.reduce((document, overlay) => applyOverlay(document, overlay), forge)
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

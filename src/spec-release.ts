import source from './generated/forge-mcp/source.json'
import { MCP_TOOLS_KEY, buildMcpTools, type OperationInfo } from './openapi'
import { extractProducts, processSpec } from './spec-processor'

/**
 * The `openapi.forge.json` release this deployment serves, `openapi@<sha>`:
 * Code Mode, the endpoint tools and the forge tools all come from it. The forge
 * tools workflow proposes a newer release in a pull request, so a release
 * reaches users only once someone has reviewed and merged it.
 */
export const SPEC_RELEASE: string = source.release

/**
 * The artifacts built from the spec, by name. `scripts/generate-tools.ts`
 * writes them to `src/generated/spec`, and the forge tools service serves them.
 */
export interface SpecArtifacts {
  readonly 'spec.json': string
  readonly 'products.json': string
  readonly [MCP_TOOLS_KEY]: string
}

/** The name of a spec artifact. */
export type SpecArtifactName = keyof SpecArtifacts

/** Builds the spec artifacts from the raw OpenAPI document. */
export function buildSpecArtifacts(rawSpec: Record<string, unknown>): SpecArtifacts {
  const processed = processSpec(rawSpec) as { paths: Record<string, Record<string, OperationInfo>> }
  return {
    'spec.json': JSON.stringify(processed),
    'products.json': JSON.stringify(extractProducts(rawSpec)),
    [MCP_TOOLS_KEY]: JSON.stringify(buildMcpTools(processed.paths))
  }
}

import source from './generated/forge-mcp/source.json'

/**
 * The `openapi.forge.json` release this deployment serves, `openapi@<sha>`:
 * Code Mode, the endpoint tools and the forge tools all come from it. The forge
 * tools workflow proposes a newer release in a pull request, so a release
 * reaches users only once someone has reviewed and merged it.
 */
export const SPEC_RELEASE: string = source.release

/**
 * The artifacts built from the spec. `scripts/generate-tools.ts` writes them to
 * `src/generated/spec`, and the forge tools service serves them.
 */
export type SpecArtifactName = 'spec.json' | 'products.json' | 'mcp-tools.json'

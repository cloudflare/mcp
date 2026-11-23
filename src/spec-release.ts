import source from './generated/forge-mcp/source.json'

/** The repository whose `openapi.json` this deployment serves. */
export const SPEC_REPOSITORY = 'cloudflare/api-schemas'

/** The OpenAPI document's file in `SPEC_REPOSITORY`. */
export const SPEC_FILE = 'openapi.json'

/**
 * The `SPEC_REPOSITORY` commit this deployment serves, `<repository>@<sha>`,
 * or `null` for a spec generated from a local file with no commit: Code Mode,
 * the endpoint tools and the forge tools all come from it. The forge tools
 * workflow proposes a newer commit in a pull request, so a spec change reaches
 * users only once someone has reviewed and merged it.
 */
export const SPEC_REVISION: string | null = source.commit
  ? `${SPEC_REPOSITORY}@${source.commit}`
  : null

/** The download URL of `SPEC_FILE` at `commit`. */
export function specUrl(commit: string): string {
  return `https://raw.githubusercontent.com/${SPEC_REPOSITORY}/${commit}/${SPEC_FILE}`
}

/**
 * The artifacts built from the spec. `scripts/generate-tools.ts` writes them to
 * `src/generated/spec`: the forge tools service ships `spec.json` for `search`,
 * and the main Worker bundles the other two.
 */
export type SpecArtifactName = 'spec.json' | 'products.json' | 'permissions.json'

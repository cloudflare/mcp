import products from '../generated/spec/products.json.txt'
import permissions from '../generated/spec/permissions.json.txt'
import spec from '../generated/spec/spec.json.txt'
import type { SpecArtifactName } from '../spec-release'

/**
 * The spec artifacts of the pinned release (`src/generated/forge-mcp/source.json`),
 * which `scripts/generate-tools.ts` writes with the generated tools. They are
 * text modules, so loading them costs a string, not a parse.
 */
export const SPEC_ARTIFACTS: Readonly<Record<SpecArtifactName, string>> = {
  'spec.json': spec,
  'products.json': products,
  'permissions.json': permissions
}

/** Whether `name` names a spec artifact. */
export function isSpecArtifactName(name: unknown): name is SpecArtifactName {
  return typeof name === 'string' && Object.hasOwn(SPEC_ARTIFACTS, name)
}

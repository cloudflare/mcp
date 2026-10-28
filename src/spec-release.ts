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

/** Where {@link SPEC_RELEASE}'s `openapi.forge.json` downloads from. */
export const SPEC_URL = `https://github.com/cloudflare/forge/releases/download/${encodeURIComponent(SPEC_RELEASE)}/openapi.forge.json`

/** The custom metadata key on `spec.json` that names the release it came from. */
const RELEASE_METADATA = 'release'

/** The R2 objects built from the spec, by key. */
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

/** Downloads {@link SPEC_RELEASE}'s raw OpenAPI document. */
export async function downloadSpec(): Promise<Record<string, unknown>> {
  const response = await fetch(SPEC_URL)
  if (!response.ok) {
    throw new Error(`Failed to fetch OpenAPI spec ${SPEC_RELEASE}: ${response.status}`)
  }
  return (await response.json()) as Record<string, unknown>
}

/**
 * Makes R2 hold {@link SPEC_RELEASE}'s artifacts. It reads only `spec.json`'s
 * metadata when R2 already does, so it can run often and a merged pin is served
 * within minutes. `spec.json` is written last, with the release: a run that
 * fails part way leaves the old release named, and the next run writes all
 * three again.
 */
export async function syncSpec(bucket: R2Bucket): Promise<void> {
  const current = await bucket.head('spec.json')
  if (current?.customMetadata?.[RELEASE_METADATA] === SPEC_RELEASE) return

  console.log(`Syncing OpenAPI spec ${SPEC_RELEASE} from ${SPEC_URL}`)
  const artifacts = buildSpecArtifacts(await downloadSpec())
  const httpMetadata = { contentType: 'application/json' }
  await Promise.all([
    bucket.put('products.json', artifacts['products.json'], { httpMetadata }),
    bucket.put(MCP_TOOLS_KEY, artifacts[MCP_TOOLS_KEY], { httpMetadata })
  ])
  await bucket.put('spec.json', artifacts['spec.json'], {
    httpMetadata,
    customMetadata: { [RELEASE_METADATA]: SPEC_RELEASE }
  })
  console.log(
    `Spec ${SPEC_RELEASE} synced (${(artifacts['spec.json'].length / 1024).toFixed(0)} KB)`
  )
}

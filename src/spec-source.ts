import { z } from 'zod'

/**
 * Downloads `openapi.forge.json` from the latest release of a GitHub
 * repository. The server reads Forge's internal release
 * (`cloudflare/forge-internal`), which adds the OAuth scopes each operation
 * accepts as `security` requirements, so the repository is private and every
 * request carries a token with read access to its contents.
 *
 * Plain `fetch` with no Workers APIs, so `scripts/seed-r2.ts` uses it too.
 */

/** The release asset holding the spec. */
export const SPEC_ASSET = 'openapi.forge.json'

const GITHUB_API = 'https://api.github.com'

const Release = z.object({
  tag_name: z.string(),
  assets: z.array(z.object({ name: z.string(), url: z.string().url() }))
})

/**
 * The spec from the latest release of `repo`.
 *
 * @param repo - The repository, such as `cloudflare/forge-internal`.
 * @param token - A GitHub token that can read the repository's contents.
 * @returns The release tag and the parsed spec.
 */
export async function fetchLatestSpec(
  repo: string,
  token: string
): Promise<{ tag: string; spec: Record<string, unknown> }> {
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'cloudflare-mcp',
    'X-GitHub-Api-Version': '2022-11-28'
  }

  const latest = await fetch(`${GITHUB_API}/repos/${repo}/releases/latest`, {
    headers: { ...headers, Accept: 'application/vnd.github+json' }
  })
  if (!latest.ok)
    throw new Error(`Failed to read the latest ${repo} release: HTTP ${latest.status}`)
  const release = Release.parse(await latest.json())
  const asset = release.assets.find((candidate) => candidate.name === SPEC_ASSET)
  if (!asset) throw new Error(`The ${repo} release ${release.tag_name} has no ${SPEC_ASSET}`)

  // The asset URL redirects to a signed download URL, which must not get the token.
  const pointer = await fetch(asset.url, {
    headers: { ...headers, Accept: 'application/octet-stream' },
    redirect: 'manual'
  })
  const location = pointer.headers.get('location')
  const redirected = pointer.status >= 300 && pointer.status < 400 && location
  if (redirected) await pointer.body?.cancel()
  const download = redirected ? await fetch(location) : pointer
  if (!download.ok) {
    throw new Error(
      `Failed to download ${SPEC_ASSET} from ${repo} ${release.tag_name}: HTTP ${download.status}`
    )
  }
  return { tag: release.tag_name, spec: (await download.json()) as Record<string, unknown> }
}

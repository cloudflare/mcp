/**
 * Download the newest Forge OpenAPI document.
 *
 * `releases/latest/download/<asset>` redirects to the newest release's asset
 * without the rate-limited GitHub REST API. The first redirect names the
 * release (`.../releases/download/openapi@<sha>/openapi.forge.json`), which is
 * returned as `x-forge-release`. No runtime imports, so the seed script can
 * use it under Node too.
 */

export const FORGE_LATEST_URL =
  'https://github.com/cloudflare/forge/releases/latest/download/openapi.forge.json'

const RELEASE_PATTERN = /\/releases\/download\/([^/]+)\/openapi\.forge\.json$/
const USER_AGENT = 'cloudflare-mcp-tools-builder'

export async function latestForgeSpec(fetcher: typeof fetch): Promise<Response> {
  const headers = { 'user-agent': USER_AGENT }
  const redirect = await fetcher(FORGE_LATEST_URL, { headers, redirect: 'manual' })
  const location = redirect.headers.get('location')
  const release = location ? RELEASE_PATTERN.exec(new URL(location).pathname)?.[1] : undefined
  if (!location || !release) {
    throw new Error(`GET ${FORGE_LATEST_URL} did not redirect to a release (${redirect.status})`)
  }

  const asset = await fetcher(location, { headers })
  if (!asset.ok || !asset.body) throw new Error(`GET ${location} failed: ${asset.status}`)
  return new Response(asset.body, {
    headers: {
      'content-type': 'application/json',
      'x-forge-release': decodeURIComponent(release)
    }
  })
}

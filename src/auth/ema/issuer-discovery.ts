import { z } from 'zod'

import { USER_AGENT } from '../../constants'

/** What a tenant needs to know about its IdP, discovered from the IdP's own metadata. */
export interface DiscoveredIssuer {
  issuer: string
  jwksUri: string
  algorithms: ('RS256' | 'ES256')[]
}

const MAX_METADATA_BYTES = 64 * 1024
const FETCH_TIMEOUT_MS = 10_000

const IssuerMetadataSchema = z.object({
  issuer: z.string(),
  jwks_uri: z.string().url(),
  id_token_signing_alg_values_supported: z.array(z.string()).optional()
})

const JwksSchema = z.object({
  keys: z.array(z.object({ kty: z.string(), alg: z.string().optional() })).min(1)
})

/** Thrown with a message the admin page can show as is. */
export class IssuerDiscoveryError extends Error {}

/**
 * The metadata URLs to try for `issuer`, in order: RFC 8414 (well-known segment before the
 * issuer's path), then OpenID Connect Discovery (appended to the issuer).
 */
export function metadataUrls(issuer: string): string[] {
  const url = new URL(issuer)
  const path = url.pathname.replace(/\/$/, '')
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`
  ]
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new IssuerDiscoveryError(`${url} answered ${response.status}`)
  }
  const text = await response.text()
  if (text.length > MAX_METADATA_BYTES) throw new IssuerDiscoveryError(`${url} is too large`)
  try {
    return JSON.parse(text)
  } catch {
    throw new IssuerDiscoveryError(`${url} did not return JSON`)
  }
}

/**
 * Validate an IdP issuer URL and discover its JWKS. The admin types only the issuer: the JWKS
 * URL comes from metadata whose `issuer` matches exactly, and the JWKS must parse. The Worker
 * runs with `global_fetch_strictly_public`, so none of this can reach a private address.
 *
 * @throws IssuerDiscoveryError when the issuer isn't HTTPS, has no matching metadata, or its JWKS
 * is unusable.
 */
export async function discoverIssuer(input: string): Promise<DiscoveredIssuer> {
  let issuer: URL
  try {
    issuer = new URL(input.trim())
  } catch {
    throw new IssuerDiscoveryError('The issuer must be a URL')
  }
  if (issuer.protocol !== 'https:' || issuer.search || issuer.hash || issuer.username) {
    throw new IssuerDiscoveryError('The issuer must be an https URL without a query or fragment')
  }
  const issuerString = input.trim()

  const failures: string[] = []
  for (const url of metadataUrls(issuerString)) {
    let metadata: z.infer<typeof IssuerMetadataSchema>
    try {
      const parsed = IssuerMetadataSchema.safeParse(await fetchJson(url))
      if (!parsed.success) {
        failures.push(`${url} has no jwks_uri`)
        continue
      }
      metadata = parsed.data
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
      continue
    }
    if (metadata.issuer !== issuerString) {
      failures.push(`${url} names issuer ${metadata.issuer}`)
      continue
    }
    const jwksUri = new URL(metadata.jwks_uri)
    if (jwksUri.protocol !== 'https:') throw new IssuerDiscoveryError('The JWKS URL must be https')

    const jwks = JwksSchema.safeParse(await fetchJson(jwksUri.href))
    if (!jwks.success) throw new IssuerDiscoveryError(`${jwksUri.href} is not a usable JWKS`)

    const algorithms = new Set<'RS256' | 'ES256'>()
    for (const key of jwks.data.keys) {
      if (key.alg === 'RS256' || (key.kty === 'RSA' && !key.alg)) algorithms.add('RS256')
      if (key.alg === 'ES256' || (key.kty === 'EC' && !key.alg)) algorithms.add('ES256')
    }
    if (algorithms.size === 0) {
      throw new IssuerDiscoveryError('The JWKS has no RS256 or ES256 signing key')
    }
    return { issuer: issuerString, jwksUri: jwksUri.href, algorithms: [...algorithms] }
  }
  throw new IssuerDiscoveryError(`No usable metadata for ${issuerString}: ${failures.join('; ')}`)
}

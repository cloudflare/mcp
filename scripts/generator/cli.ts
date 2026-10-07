import type { ForgeOpenApiDocument } from '@cloudflare/forge'
import { buildArtifacts } from './artifacts.ts'

/**
 * Container entrypoint. The container has no internet access: the ToolsBuilder
 * Durable Object routes these two hostnames to Worker code (`BuildEgress`), so
 * they are the only requests that can leave it.
 */
const FORGE_URL = process.env.FORGE_URL ?? 'http://forge.internal/openapi.forge.json'
const ARTIFACTS_URL = process.env.ARTIFACTS_URL ?? 'http://artifacts.internal/'

async function main(): Promise<void> {
  const response = await fetch(FORGE_URL)
  if (!response.ok) throw new Error(`GET ${FORGE_URL} failed: ${response.status}`)
  const release = response.headers.get('x-forge-release') ?? 'unknown'
  const artifacts = await buildArtifacts((await response.json()) as ForgeOpenApiDocument)

  // Upload only after everything generated, so a failed build writes nothing.
  for (const [key, content] of Object.entries(artifacts.files)) {
    const put = await fetch(new URL(key, ARTIFACTS_URL), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-forge-release': release },
      body: content
    })
    if (!put.ok) throw new Error(`PUT ${key} failed: ${put.status} ${await put.text()}`)
  }

  const { tools, products } = artifacts
  console.log(JSON.stringify({ release, tools, products }))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exitCode = 1
})

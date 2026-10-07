import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ForgeOpenApiDocument } from '@cloudflare/forge'
import { latestForgeSpec } from '../src/forge-source.ts'
import { buildArtifacts } from './generator/artifacts.ts'

/**
 * Seed an R2 bucket with the artifacts the daily ToolsBuilder build writes,
 * generated locally from the newest Forge release. Use it to bootstrap a new
 * bucket or for local development (`local`, which writes to wrangler's local R2).
 */
const target = process.argv[2]
if (!target || !['local', 'staging', 'production'].includes(target)) {
  console.error('Usage: npx tsx scripts/seed-r2.ts <local|staging|production>')
  process.exit(1)
}

const response = await latestForgeSpec(fetch)
const release = response.headers.get('x-forge-release')
console.log(`Generating from ${release}...`)
const { files, tools, products } = await buildArtifacts(
  (await response.json()) as ForgeOpenApiDocument
)
console.log(`${tools} tools, ${products} products`)

const bucket = target === 'local' ? 'mcp-spec' : `mcp-spec-${target}`
const location = target === 'local' ? '--local' : `--env ${target} --remote`
const directory = mkdtempSync(join(tmpdir(), 'mcp-seed-'))
try {
  for (const [key, content] of Object.entries(files)) {
    const file = join(directory, key)
    writeFileSync(file, content)
    console.log(`Uploading ${key} (${(content.length / 1024 / 1024).toFixed(1)} MB)...`)
    execSync(
      `npx wrangler r2 object put ${bucket}/${key} --file "${file}" --content-type application/json ${location}`,
      { stdio: 'inherit' }
    )
  }
  console.log('Done!')
} finally {
  rmSync(directory, { recursive: true })
}

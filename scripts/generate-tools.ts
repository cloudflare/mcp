// Generates the Cloudflare direct-tool catalogue into generated/forge/:
//
//   npm run generate:tools [-- path/to/openapi.forge.json]
//
// Without a path, it downloads openapi.forge.json from the latest Forge release.
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { generateForgeTools } from './forge-tools'

export const FORGE_SPEC_URL =
  'https://github.com/cloudflare/forge/releases/latest/download/openapi.forge.json'

const outDir = resolve(import.meta.dirname, '..', 'generated', 'forge')
let spec = process.argv[2]
if (!spec) {
  mkdirSync(outDir, { recursive: true })
  spec = join(outDir, 'openapi.forge.json')
  console.log(`Downloading ${FORGE_SPEC_URL}...`)
  const response = await fetch(FORGE_SPEC_URL)
  if (!response.ok) throw new Error(`Failed to fetch the Forge spec: ${response.status}`)
  writeFileSync(spec, Buffer.from(await response.arrayBuffer()))
}

console.log(`Wrote ${generateForgeTools(resolve(spec), outDir)}`)

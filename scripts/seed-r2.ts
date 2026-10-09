import { execSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { processSpec, extractProducts } from '../src/spec-processor'
import { MCP_TOOLS_KEY, buildMcpTools, type OperationInfo } from '../src/openapi'
import { fetchSkills } from '../src/skills/sync'
import { SKILLS_MANIFEST_KEY, skillFileKey } from '../src/skills/types'

const OPENAPI_SPEC_URL =
  'https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json'

const env = process.argv[2]
if (!env || !['staging', 'production'].includes(env)) {
  console.error('Usage: npx tsx scripts/seed-r2.ts <staging|production>')
  process.exit(1)
}

console.log(`Fetching OpenAPI spec from ${OPENAPI_SPEC_URL}...`)
const response = await fetch(OPENAPI_SPEC_URL)
if (!response.ok) {
  throw new Error(`Failed to fetch spec: ${response.status}`)
}

const rawSpec = (await response.json()) as Record<string, unknown>
console.log('Processing spec, resolving $refs...')

const processed = processSpec(rawSpec)
const specJson = JSON.stringify(processed)

const products = extractProducts(rawSpec)
const productsJson = JSON.stringify(products)
const paths = (processed as { paths: Record<string, Record<string, OperationInfo>> }).paths
const mcpToolsJson = JSON.stringify(buildMcpTools(paths))

console.log(`Spec: ${(specJson.length / 1024 / 1024).toFixed(1)} MB, ${products.length} products`)

const skills = await fetchSkills()
const skillsManifestJson = JSON.stringify(skills.manifest)
console.log(`Skills: ${skills.manifest.skills.length} skills, ${skills.blobs.size} files`)

const tmp = mkdtempSync(join(tmpdir(), 'mcp-seed-'))
const specPath = join(tmp, 'spec.json')
const productsPath = join(tmp, 'products.json')
const mcpToolsPath = join(tmp, MCP_TOOLS_KEY)
const skillsManifestPath = join(tmp, 'skills-manifest.json')
const skillFilesDir = join(tmp, 'skill-files')
const skillFilesListPath = join(tmp, 'skill-files.json')

try {
  writeFileSync(specPath, specJson)
  writeFileSync(productsPath, productsJson)
  writeFileSync(mcpToolsPath, mcpToolsJson)
  writeFileSync(skillsManifestPath, skillsManifestJson)
  mkdirSync(skillFilesDir)
  const skillFiles = [...skills.blobs].map(([digest, bytes]) => {
    const file = join(skillFilesDir, digest.slice('sha256:'.length))
    writeFileSync(file, bytes)
    return { key: skillFileKey(digest), file }
  })
  writeFileSync(skillFilesListPath, JSON.stringify(skillFiles))

  // Skill files go up before the manifest that names them.
  console.log(`Uploading ${skillFiles.length} skill files to R2 (--env ${env})...`)
  execSync(
    `npx wrangler r2 bulk put mcp-spec-${env} --filename "${skillFilesListPath}" --env ${env} --remote`,
    { stdio: 'inherit' }
  )

  for (const [key, path] of [
    ['spec.json', specPath],
    ['products.json', productsPath],
    [MCP_TOOLS_KEY, mcpToolsPath],
    [SKILLS_MANIFEST_KEY, skillsManifestPath]
  ] as const) {
    console.log(`Uploading ${key} to R2 (--env ${env})...`)
    execSync(
      `npx wrangler r2 object put mcp-spec-${env}/${key} --file "${path}" --content-type application/json --env ${env} --remote`,
      { stdio: 'inherit' }
    )
  }

  console.log('Done!')
} finally {
  rmSync(tmp, { recursive: true })
}

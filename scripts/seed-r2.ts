import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cfEnv } from './cloudflare-account'
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { processSpec, extractProducts } from '../src/spec-processor'
import { MCP_TOOLS_KEY, buildMcpTools, type OperationInfo } from '../src/openapi'
import { fetchSkills } from '../src/skills/sync'
import { SKILLS_MANIFEST_KEY, skillFileKey } from '../src/skills/types'

const OPENAPI_SPEC_URL =
  'https://github.com/cloudflare/forge/releases/latest/download/openapi.forge.json'

/** Skill files uploaded at once; `cf` uploads one object per call. */
const UPLOAD_CONCURRENCY = 8

const run = promisify(execFile)

/** Attempts per upload; an upload rewrites the same key, so retrying is safe. */
const UPLOAD_ATTEMPTS = 3

/** Upload one file to the environment's spec bucket with the `cf` CLI. */
async function put(bucket: string, key: string, file: string, contentType?: string): Promise<void> {
  const args = ['r2', 'objects', 'put', key, '--bucket-name', bucket, '--file', file, '--quiet']
  if (contentType) args.push('--content-type', contentType)
  for (let attempt = 1; ; attempt++) {
    try {
      await run('cf', args, { env: cfEnv() })
      return
    } catch (error) {
      if (attempt === UPLOAD_ATTEMPTS) throw error
      console.warn(`Retrying ${key} (attempt ${attempt} failed)`)
    }
  }
}

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
const bucket = `mcp-spec-${env}`

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

  // Skill files go up before the manifest that names them.
  console.log(`Uploading ${skillFiles.length} skill files to ${bucket}...`)
  const queue = [...skillFiles]
  await Promise.all(
    Array.from({ length: UPLOAD_CONCURRENCY }, async () => {
      for (let next = queue.shift(); next; next = queue.shift())
        await put(bucket, next.key, next.file)
    })
  )

  for (const [key, path] of [
    ['spec.json', specPath],
    ['products.json', productsPath],
    [MCP_TOOLS_KEY, mcpToolsPath],
    [SKILLS_MANIFEST_KEY, skillsManifestPath]
  ] as const) {
    console.log(`Uploading ${key} to ${bucket}...`)
    await put(bucket, key, path, 'application/json')
  }

  console.log('Done!')
} finally {
  rmSync(tmp, { recursive: true })
}

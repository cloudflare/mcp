import { execSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { processSpec, extractProducts } from '../src/spec-processor'
import { buildNonCodemodeTools, type OperationInfo } from '../src/openapi'
import { buildOperationPolicyArtifact, policyCoverage } from '../src/auth/operation-scopes'

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

const rawSchema = await response.text()
const rawSpec = JSON.parse(rawSchema) as Record<string, unknown>
console.log('Processing spec, resolving $refs...')

const processed = processSpec(rawSpec)
const specJson = JSON.stringify(processed)

const products = extractProducts(rawSpec)
const productsJson = JSON.stringify(products)
const paths = (processed as { paths: Record<string, Record<string, OperationInfo>> }).paths
const nonCodemodeToolsJson = JSON.stringify(buildNonCodemodeTools(paths))
const operationPolicies = await buildOperationPolicyArtifact(paths, rawSchema)
const operationPoliciesJson = JSON.stringify(operationPolicies)
console.log('Operation scope policy coverage:', policyCoverage(operationPolicies.operations))

console.log(`Spec: ${(specJson.length / 1024 / 1024).toFixed(1)} MB, ${products.length} products`)

const tmp = mkdtempSync(join(tmpdir(), 'mcp-seed-'))
const specPath = join(tmp, 'spec.json')
const productsPath = join(tmp, 'products.json')
const nonCodemodeToolsPath = join(tmp, 'non-codemode-tools.json')
const operationPoliciesPath = join(tmp, 'operation-scopes.json')

try {
  writeFileSync(specPath, specJson)
  writeFileSync(productsPath, productsJson)
  writeFileSync(nonCodemodeToolsPath, nonCodemodeToolsJson)
  writeFileSync(operationPoliciesPath, operationPoliciesJson)

  for (const [key, path] of [
    ['spec.json', specPath],
    ['products.json', productsPath],
    ['non-codemode-tools.json', nonCodemodeToolsPath],
    ['operation-scopes.json', operationPoliciesPath]
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

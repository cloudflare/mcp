import { readFile } from 'node:fs/promises'
import { processSpec } from '../src/spec-processor'
import { buildOperationPolicyArtifact, policyCoverage } from '../src/auth/operation-scopes'
import type { OperationInfo } from '../src/openapi'

const file = process.argv[2]
if (!file) throw new Error('Usage: npx tsx scripts/report-operation-scopes.ts <raw-openapi.json>')
const raw = await readFile(file, 'utf8')
const processed = processSpec(JSON.parse(raw))
const artifact = await buildOperationPolicyArtifact(processed.paths as Record<string, Record<string, OperationInfo>>, raw)
console.log(JSON.stringify({
  rawSchemaHash: artifact.rawSchemaHash, catalogHash: artifact.catalogHash,
  resolverVersion: artifact.resolverVersion, ...policyCoverage(artifact.operations),
  unresolvedLabels: [...new Set(artifact.operations.flatMap((policy) =>
    policy.alternatives.filter((item) => item.unresolved).map((item) => item.label)))].sort()
}, null, 2))

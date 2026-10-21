/**
 * Regenerates `src/generated/forge-mcp`, the direct tools served at
 * `/mcp?codemode=false&experimentalForge=true`, with forge's MCP target:
 *
 *   FORGE_BINARY=path/to/forge npm run generate:tools [-- --spec openapi.forge.json] [-- --summary summary.md]
 *
 * `forge.json` names the forge commit to build; `.github/workflows/forge-tools.yml`
 * builds it, runs this every six hours, and opens a pull request when the
 * generated code changes. Without `--spec`, the latest `openapi.forge.json`
 * Forge release is downloaded. `--summary` writes the tools added and removed
 * as Markdown, for the pull request.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const SPEC_URL = 'https://github.com/cloudflare/forge/releases/latest/download/openapi.forge.json'
const OUT = 'src/generated/forge-mcp'

const { values } = parseArgs({ options: { spec: { type: 'string' }, summary: { type: 'string' } } })
const forge = process.env.FORGE_BINARY ?? 'forge'
const tmp = mkdtempSync(join(tmpdir(), 'forge-mcp-'))

try {
  let spec = values.spec
  if (!spec) {
    console.log(`Downloading ${SPEC_URL}`)
    const response = await fetch(SPEC_URL)
    if (!response.ok) throw new Error(`Failed to download the spec: HTTP ${response.status}`)
    spec = join(tmp, 'openapi.forge.json')
    writeFileSync(spec, Buffer.from(await response.arrayBuffer()))
  }

  const out = join(tmp, 'out')
  execFileSync(forge, [spec, '--target', 'mcp', '--out', out], { stdio: 'inherit' })

  const before = toolNames(OUT)
  rmSync(OUT, { recursive: true, force: true })
  renameSync(out, OUT)
  const after = toolNames(OUT)

  const added = [...after].filter((name) => !before.has(name)).sort()
  const removed = [...before].filter((name) => !after.has(name)).sort()
  console.log(`${after.size} tools: ${added.length} added, ${removed.length} removed`)
  if (values.summary) writeFileSync(values.summary, summary(after.size, added, removed))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

/** The names of the generated tools in `dir`, read from each `tools.ts`. */
function toolNames(dir: string): Set<string> {
  const names = new Set<string>()
  if (!existsSync(dir)) return names
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === 'tools.ts') {
      const source = readFileSync(join(entry.parentPath, entry.name), 'utf8')
      for (const match of source.matchAll(/^ {4}name: "([^"]+)",$/gm)) names.add(match[1]!)
    }
  }
  return names
}

function summary(count: number, added: string[], removed: string[]): string {
  const list = (names: string[]) => names.map((name) => `- \`${name}\``).join('\n')
  return [
    `${count} tools: ${added.length} added, ${removed.length} removed.`,
    removed.length > 0
      ? `\n**Removed** (clients calling these will get "not found"):\n\n${list(removed)}`
      : '',
    added.length > 0 ? `\n<details><summary>Added</summary>\n\n${list(added)}\n\n</details>` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

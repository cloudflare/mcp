/**
 * Regenerates `src/generated/forge-mcp`, the direct tools served at
 * `/mcp?codemode=false&experimentalForge=true`, with forge's MCP target:
 *
 *   FORGE_BINARY=path/to/forge npm run generate:tools [-- --spec openapi.forge.json --release <tag>] [-- --summary summary.md]
 *
 * `forge.json` names the forge commit to build; `.github/workflows/forge-tools.yml`
 * builds it, runs this every six hours, and opens a pull request when the
 * generated code changes. Without `--spec`, the latest `openapi.forge.json`
 * Forge release is downloaded. `source.json` records the release, so a
 * response that breaks a generated response schema names the spec it came
 * from (`--release` gives it for a local `--spec`). `--summary` writes the
 * tools added and removed as Markdown, for the pull request.
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

const LATEST_RELEASE = 'https://api.github.com/repos/cloudflare/forge/releases/latest'
const SPEC_ASSET = 'openapi.forge.json'
const OUT = 'src/generated/forge-mcp'

const { values } = parseArgs({
  options: {
    spec: { type: 'string' },
    release: { type: 'string' },
    summary: { type: 'string' }
  }
})
const forge = process.env.FORGE_BINARY ?? 'forge'
const tmp = mkdtempSync(join(tmpdir(), 'forge-mcp-'))

try {
  let spec = values.spec
  let release = values.release ?? null
  if (!spec) {
    const latest = await latestRelease()
    release = latest.tag
    console.log(`Downloading ${latest.url}`)
    const response = await fetch(latest.url)
    if (!response.ok) throw new Error(`Failed to download the spec: HTTP ${response.status}`)
    spec = join(tmp, SPEC_ASSET)
    writeFileSync(spec, Buffer.from(await response.arrayBuffer()))
  }

  const out = join(tmp, 'out')
  execFileSync(forge, [spec, '--target', 'mcp', '--out', out], { stdio: 'inherit' })

  const before = toolNames(OUT)
  rmSync(OUT, { recursive: true, force: true })
  renameSync(out, OUT)
  writeFileSync(join(OUT, 'source.json'), `${JSON.stringify({ release }, null, 2)}\n`)
  const after = toolNames(OUT)

  const added = [...after].filter((name) => !before.has(name)).sort()
  const removed = [...before].filter((name) => !after.has(name)).sort()
  console.log(`${after.size} tools: ${added.length} added, ${removed.length} removed`)
  if (values.summary) writeFileSync(values.summary, summary(after.size, added, removed))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

/** The latest Forge release's tag and the download URL of its `openapi.forge.json`. */
async function latestRelease(): Promise<{ tag: string; url: string }> {
  const token = process.env.GITHUB_TOKEN
  const response = await fetch(LATEST_RELEASE, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token && { Authorization: `Bearer ${token}` })
    }
  })
  if (!response.ok) throw new Error(`Failed to read the latest release: HTTP ${response.status}`)
  const { tag_name: tag, assets } = (await response.json()) as {
    tag_name: string
    assets: Array<{ name: string; browser_download_url: string }>
  }
  const asset = assets.find((item) => item.name === SPEC_ASSET)
  if (!asset) throw new Error(`The release ${tag} has no ${SPEC_ASSET}`)
  return { tag, url: asset.browser_download_url }
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

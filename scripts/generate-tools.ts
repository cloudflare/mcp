/**
 * Regenerates `src/generated/forge-mcp`, the direct tools served at
 * `/mcp?codemode=false`, with forge's MCP target:
 *
 *   npm run generate:tools [-- --commit <sha>] [-- --spec openapi.json] [-- --summary summary.md]
 *
 * The forge that generates them is the `@cloudflare/forge` package in
 * `package.json`, a pkg.pr.new build of a forge commit; bumping that pin picks
 * up generator changes. `.github/workflows/forge-tools.yml` runs this every six
 * hours and opens a pull request when the generated code changes.
 *
 * The spec is `openapi.json` from `cloudflare/api-schemas`: at `--commit`, or
 * at the latest commit on `main` that changed it, or read from a local
 * `--spec` (`--commit` then names the commit it came from). `source.json`
 * records the commit, so a response that breaks a generated response schema
 * names the spec it came from. `--summary` writes the tools added and removed
 * as Markdown, for the pull request.
 *
 * The same commit's spec artifacts go to `src/generated/spec` as text
 * modules: `spec.json` for Code Mode's `search`, `products.json`, and
 * `permissions.json`, each operation's accepted permissions, for explaining a
 * refused `execute` request. The forge tools service serves
 * them, so every deploy carries the spec it was reviewed with.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import type { OperationInfo } from '../src/openapi'
import { concretePaths, extractProducts, processSpec } from '../src/spec-processor'
import { SPEC_FILE, SPEC_REPOSITORY, specUrl, type SpecArtifactName } from '../src/spec-release'

/** Builds the spec artifacts the forge tools service serves from the raw OpenAPI document. */
function buildSpecArtifacts(rawSpec: Record<string, unknown>): Record<SpecArtifactName, string> {
  const processed = processSpec(rawSpec) as { paths: Record<string, Record<string, OperationInfo>> }
  return {
    'spec.json': JSON.stringify(processed),
    'products.json': JSON.stringify(extractProducts(rawSpec)),
    'permissions.json': JSON.stringify(permissionPaths(processed.paths))
  }
}

/** Each operation's `x-api-token-group`, by path template and method. */
function permissionPaths(
  paths: Record<string, Record<string, OperationInfo>>
): Record<string, Record<string, Pick<OperationInfo, 'x-api-token-group'>>> {
  return Object.fromEntries(
    Object.entries(paths).map(([path, operations]) => [
      path,
      Object.fromEntries(
        Object.entries(operations).map(([method, operation]) => [
          method,
          operation['x-api-token-group']
            ? { 'x-api-token-group': operation['x-api-token-group'] }
            : {}
        ])
      )
    ])
  )
}

const COMMIT = /^[0-9a-f]{40}$/
const OUT = 'src/generated/forge-mcp'
const SPEC_OUT = 'src/generated/spec'
/** A drop in tools with permissions below this share of before warns in the summary. */
const PERMISSIONS_DROP_WARNING = 0.95

const { values } = parseArgs({
  options: {
    spec: { type: 'string' },
    commit: { type: 'string' },
    summary: { type: 'string' }
  }
})
/** The `forge` command of the pinned `@cloudflare/forge` package. */
const forgeBin = join(
  dirname(createRequire(import.meta.url).resolve('@cloudflare/forge/package.json')),
  'bin',
  'forge.cjs'
)
const forge = (args: string[]) =>
  execFileSync(process.execPath, [forgeBin, ...args], { stdio: 'inherit' })
const tmp = mkdtempSync(join(tmpdir(), 'forge-mcp-'))

try {
  if (values.commit !== undefined && !COMMIT.test(values.commit)) {
    throw new Error(`--commit must be a full commit SHA, not ${values.commit}`)
  }
  let commit = values.commit ?? null
  let text: string
  if (values.spec) {
    text = readFileSync(values.spec, 'utf8')
  } else {
    commit ??= await latestCommit()
    const url = specUrl(commit)
    console.log(`Downloading ${url}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to download the spec: HTTP ${response.status}`)
    text = await response.text()
  }
  const rawSpec = JSON.parse(text) as Record<string, unknown>
  inheritAccountOrZonePermissions(rawSpec)

  // Forge reads only its native x-forge-* extensions; the spec also has the Fern ones.
  const normalized = join(tmp, 'openapi.normalized.json')
  writeFileSync(normalized, JSON.stringify(rawSpec))
  forge(['normalize', '--write', normalized])

  const out = join(tmp, 'out')
  forge(['generate', normalized, '--target', 'mcp', '--out', out])

  const before = toolNames(OUT)
  const permissionsBefore = withPermissions(OUT)
  rmSync(OUT, { recursive: true, force: true })
  renameSync(out, OUT)
  writeFileSync(join(OUT, 'source.json'), `${JSON.stringify({ commit }, null, 2)}\n`)

  mkdirSync(SPEC_OUT, { recursive: true })
  const artifacts = buildSpecArtifacts(rawSpec)
  for (const [name, text] of Object.entries(artifacts)) {
    writeFileSync(join(SPEC_OUT, `${name}.txt`), asciiJson(text))
  }
  const after = toolNames(OUT)
  const permissionsAfter = withPermissions(OUT)

  const added = [...after].filter((name) => !before.has(name)).sort()
  const removed = [...before].filter((name) => !after.has(name)).sort()
  console.log(`${after.size} tools: ${added.length} added, ${removed.length} removed`)
  console.log(`Tools with permissions: ${permissionsBefore} -> ${permissionsAfter}`)
  if (values.summary) {
    writeFileSync(
      values.summary,
      summary(after.size, added, removed, { before: permissionsBefore, after: permissionsAfter })
    )
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

/**
 * Returns `json` with every character above U+007F escaped as `\uXXXX`. It is
 * the same JSON, but V8 keeps an all-ASCII string at one byte per character:
 * the 710 non-Latin-1 characters in `spec.json` would otherwise make its 26.7M
 * characters a 53 MB two-byte string in every isolate that holds it.
 */
function asciiJson(json: string): string {
  return json.replace(
    /[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

/** The latest commit on `main` of `SPEC_REPOSITORY` that changed `SPEC_FILE`. */
async function latestCommit(): Promise<string> {
  const token = process.env.GITHUB_TOKEN
  const query = new URLSearchParams({ sha: 'main', path: SPEC_FILE, per_page: '1' })
  const response = await fetch(`https://api.github.com/repos/${SPEC_REPOSITORY}/commits?${query}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      ...(token && { Authorization: `Bearer ${token}` })
    }
  })
  if (!response.ok) throw new Error(`Failed to read the latest commit: HTTP ${response.status}`)
  const [latest] = (await response.json()) as Array<{ sha?: unknown }>
  if (typeof latest?.sha !== 'string' || !COMMIT.test(latest.sha)) {
    throw new Error(`${SPEC_REPOSITORY} has no commit that changed ${SPEC_FILE}`)
  }
  return latest.sha
}

/**
 * Gives each `/{account_or_zone}/{account_or_zone_id}/…` operation that lists
 * no `x-api-token-group` the permissions of its account and zone routes. The
 * spec lists those routes too, with their permissions, but forge generates
 * only the merged operation's tool, and refusal explanations and scope
 * step-up read the tool's permissions. `authorize()` counts only the variant
 * that matches the request path, so the tool lists both routes'.
 */
function inheritAccountOrZonePermissions(spec: Record<string, unknown>): void {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>
  for (const [path, item] of Object.entries(paths)) {
    const routes = concretePaths(path).filter(({ scope }) => scope)
    if (routes.length === 0) continue
    for (const [method, operation] of Object.entries(item)) {
      if (typeof operation !== 'object' || Array.isArray(operation)) continue
      if (!operation || operation['x-api-token-group']) continue
      const permissions = new Set(
        routes.flatMap(({ path: route }) => {
          const group = paths[route]?.[method]?.['x-api-token-group']
          return Array.isArray(group) ? group : []
        })
      )
      if (permissions.size > 0) operation['x-api-token-group'] = [...permissions]
    }
  }
}

/** How many generated tools in `dir` list the permissions they accept. */
function withPermissions(dir: string): number {
  let count = 0
  if (!existsSync(dir)) return count
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === 'tools.ts') {
      const source = readFileSync(join(entry.parentPath, entry.name), 'utf8')
      count += source.match(/^ {8}"x-api-token-group": /gm)?.length ?? 0
    }
  }
  return count
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

function summary(
  count: number,
  added: string[],
  removed: string[],
  permissions: { before: number; after: number }
): string {
  const list = (names: string[]) => names.map((name) => `- \`${name}\``).join('\n')
  // Refusal explanations and scope step-up read each tool's permissions, so a
  // spec that drops them breaks both. The Forge release openapi@67443a2 dropped 90%.
  const dropped = permissions.after < permissions.before * PERMISSIONS_DROP_WARNING
  return [
    `${count} tools: ${added.length} added, ${removed.length} removed.`,
    `Tools with permissions (\`x-api-token-group\`): ${permissions.before} → ${permissions.after}.`,
    dropped
      ? "\n**Warning:** this commit drops the permissions of many tools. Refusal explanations and scope step-up need them, in Code Mode too. Don't merge it until the spec is fixed."
      : '',
    removed.length > 0
      ? `\n**Removed** (clients calling these will get "not found"):\n\n${list(removed)}`
      : '',
    added.length > 0 ? `\n<details><summary>Added</summary>\n\n${list(added)}\n\n</details>` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

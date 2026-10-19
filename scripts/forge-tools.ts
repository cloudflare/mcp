import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const bin = (name: string) => join(root, 'node_modules', '.bin', name)

/**
 * Builds the Cloudflare forge-mcp plugin and runs forge on an
 * `openapi.forge.json`, writing `mcp-tools.json` into `outDir`.
 * Returns the catalogue's path.
 */
export function generateForgeTools(spec: string, outDir: string): string {
  mkdirSync(outDir, { recursive: true })
  const plugin = join(outDir, 'cloudflare-mcp.wasm')
  execFileSync(
    bin('forge-plugin'),
    ['build', join(root, 'src/forge-tools/plugin-entry.ts'), '-o', plugin],
    {
      stdio: 'inherit'
    }
  )
  execFileSync(bin('forge'), [spec, '--target', `wasm://${plugin}`, '--out', outDir], {
    stdio: 'inherit'
  })

  const path = join(outDir, 'mcp-tools.json')
  const catalogue = JSON.parse(readFileSync(path, 'utf8')) as {
    tools: unknown[]
    skipped: unknown[]
  }
  console.log(`forge-mcp: ${catalogue.tools.length} tools, ${catalogue.skipped.length} skipped`)
  return path
}

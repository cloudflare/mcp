import { buffer } from 'node:stream/consumers'
import type { ForgeOpenApiDocument } from '@cloudflare/forge'
import { generateMcpTools } from './mcp.ts'

/**
 * Container entrypoint: read a bundled Forge OpenAPI document on stdin and
 * write mcp-tools.json on stdout. It has no network access and no bindings;
 * the ToolsBuilder Durable Object supplies the input and stores the output.
 */
async function main(): Promise<void> {
  const source = JSON.parse((await buffer(process.stdin)).toString('utf8')) as ForgeOpenApiDocument
  const [file] = await generateMcpTools(source)
  if (!file) throw new Error('Generator emitted no artifact')
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(file.content, (error) => (error ? reject(error) : resolve()))
  )
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exitCode = 1
})

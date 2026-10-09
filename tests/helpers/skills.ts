import { env } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { resetIsolateCache } from '../../src/isolate-cache'
import { SKILLS_ARCHIVE_URL, syncSkills } from '../../src/skills/sync'
import { server } from '../setup/msw'

/**
 * Builders for `git archive`-style tarballs, so tests can serve a fake
 * `cloudflare/skills` download through MSW and run the real sync over it.
 */

const encoder = new TextEncoder()
const BLOCK = 512

export interface ArchiveEntry {
  readonly path: string
  readonly content?: string | Uint8Array
  /** Tar type flag. Defaults to a regular file ('0'). */
  readonly type?: '0' | '2' | '5'
}

function writeField(header: Uint8Array, offset: number, length: number, value: string): void {
  header.set(encoder.encode(value).subarray(0, length), offset)
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, '0') + '\0'
}

function tarEntry(name: string, type: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(BLOCK)
  writeField(header, 0, 100, name)
  writeField(header, 100, 8, octal(0o644, 8))
  writeField(header, 108, 8, octal(0, 8))
  writeField(header, 116, 8, octal(0, 8))
  writeField(header, 124, 12, octal(data.byteLength, 12))
  writeField(header, 136, 12, octal(0, 12))
  writeField(header, 148, 8, '        ')
  writeField(header, 156, 1, type)
  writeField(header, 257, 6, 'ustar\0')
  writeField(header, 263, 2, '00')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  writeField(header, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ')

  const padded = new Uint8Array(Math.ceil(data.byteLength / BLOCK) * BLOCK)
  padded.set(data)
  return concat([header, padded])
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let length = body.length + 1
  while (`${length}${body}`.length !== length) length = `${length}${body}`.length
  return `${length}${body}`
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

/** An uncompressed tar archive. Paths over 100 bytes get a pax `path` record. */
export function buildTar(entries: readonly ArchiveEntry[], commit?: string): Uint8Array {
  const parts: Uint8Array[] = []
  if (commit) {
    parts.push(tarEntry('pax_global_header', 'g', encoder.encode(paxRecord('comment', commit))))
  }
  for (const entry of entries) {
    const data =
      typeof entry.content === 'string'
        ? encoder.encode(entry.content)
        : (entry.content ?? new Uint8Array())
    if (entry.path.length > 100) {
      parts.push(tarEntry('PaxHeader', 'x', encoder.encode(paxRecord('path', entry.path))))
    }
    parts.push(tarEntry(entry.path.slice(0, 100), entry.type ?? '0', data))
  }
  parts.push(new Uint8Array(BLOCK * 2))
  return concat(parts)
}

/** A gzipped `git archive` of a skills repository, rooted at `skills-main/`. */
export async function buildSkillsArchive(
  files: Record<string, string | Uint8Array>,
  commit = 'a84b615ff9d40e7f99755aea23d65e52d645bd42'
): Promise<ArrayBuffer> {
  const tar = buildTar(
    Object.entries(files).map(([path, content]) => ({ path: `skills-main/${path}`, content })),
    commit
  )
  const stream = new Blob([tar]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}

/** A minimal valid `SKILL.md`. */
export function skillMarkdown(name: string, description: string, body = '# Skill\n'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`
}

/** Serve `files` as the `cloudflare/skills` archive for the rest of the test. */
export async function mockSkillsArchive(files: Record<string, string | Uint8Array>): Promise<void> {
  const archive = await buildSkillsArchive(files)
  server.use(http.get(SKILLS_ARCHIVE_URL, () => HttpResponse.arrayBuffer(archive)))
}

/** Run the real sync over `files` and drop the isolate cache so the server reads the result. */
export async function seedSkills(files: Record<string, string | Uint8Array>): Promise<void> {
  await mockSkillsArchive(files)
  await syncSkills(env.SPEC_BUCKET)
  resetIsolateCache()
}

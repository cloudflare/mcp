/**
 * Minimal reader for the ustar/pax archives GitHub serves from
 * `codeload.github.com/<owner>/<repo>/tar.gz/<ref>` (produced by `git archive`).
 *
 * Only regular files are returned. Directories, symlinks and hard links are
 * skipped, so an archive entry can never make the server read outside the
 * bytes it downloaded.
 */

const BLOCK = 512

export interface TarFile {
  readonly path: string
  readonly bytes: Uint8Array
}

export interface TarArchive {
  readonly files: TarFile[]
  /** The pax global `comment` record. `git archive` writes the commit SHA here. */
  readonly comment: string | undefined
}

const decoder = new TextDecoder()

function readString(block: Uint8Array, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return decoder.decode(end === -1 ? field : field.subarray(0, end))
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const text = readString(block, offset, length).trim()
  if (!/^[0-7]*$/.test(text)) throw new Error(`Invalid tar size field: ${text}`)
  return text === '' ? 0 : parseInt(text, 8)
}

/** Parse pax `"<length> <key>=<value>\n"` records. */
function readPaxRecords(bytes: Uint8Array): Map<string, string> {
  const records = new Map<string, string>()
  const text = decoder.decode(bytes)
  let position = 0
  while (position < text.length) {
    const space = text.indexOf(' ', position)
    if (space === -1) break
    const length = Number(text.slice(position, space))
    if (!Number.isInteger(length) || length <= 0) break
    const record = text.slice(space + 1, position + length - 1)
    const equals = record.indexOf('=')
    if (equals !== -1) records.set(record.slice(0, equals), record.slice(equals + 1))
    position += length
  }
  return records
}

/**
 * Read every regular file out of an uncompressed tar archive.
 *
 * @param archive - The archive bytes, already gunzipped.
 * @returns The regular files with their full archive paths, and the pax global comment.
 */
export function readTar(archive: Uint8Array): TarArchive {
  const files: TarFile[] = []
  let comment: string | undefined
  let nextPath: string | undefined
  let offset = 0

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break

    const size = readOctal(header, 124, 12)
    const type = String.fromCharCode(header[156] ?? 0)
    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > archive.length) throw new Error('Truncated tar archive')
    const data = archive.subarray(dataStart, dataEnd)
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK

    if (type === 'g') {
      comment = readPaxRecords(data).get('comment') ?? comment
      continue
    }
    if (type === 'x') {
      nextPath = readPaxRecords(data).get('path') ?? nextPath
      continue
    }
    if (type === 'L') {
      nextPath = readString(data, 0, data.length)
      continue
    }

    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const path = nextPath ?? (prefix ? `${prefix}/${name}` : name)
    nextPath = undefined

    // '0' and NUL are regular files. Everything else (directories, links,
    // devices) carries no content we serve.
    if (type === '0' || type === '\0') files.push({ path, bytes: data.slice() })
  }

  return { files, comment }
}

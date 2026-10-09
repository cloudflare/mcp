import { describe, expect, it } from 'vitest'
import { buildSkill, buildSkillsBundle, parseFrontmatter } from '../../src/skills/bundle'
import { readTar } from '../../src/skills/tar'
import { MAX_RESOURCES_PER_SKILL } from '../../src/skills/types'
import { buildTar, skillMarkdown } from '../helpers/skills'

const encoder = new TextEncoder()
const bytes = (text: string) => encoder.encode(text)

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('readTar', () => {
  it('returns regular files, the pax global comment, and long pax paths', () => {
    const longPath = `repo/skills/${'deep/'.repeat(30)}file.md`
    const archive = buildTar(
      [
        { path: 'repo/', type: '5' },
        { path: 'repo/a.md', content: 'alpha' },
        { path: longPath, content: 'long' },
        { path: 'repo/link', content: '', type: '2' }
      ],
      'a84b615ff9d40e7f99755aea23d65e52d645bd42'
    )

    const { files, comment } = readTar(archive)

    expect(comment).toBe('a84b615ff9d40e7f99755aea23d65e52d645bd42')
    expect(files.map((file) => file.path)).toEqual(['repo/a.md', longPath])
    expect(new TextDecoder().decode(files[0]?.bytes)).toBe('alpha')
  })

  it('rejects an archive whose entry runs past the end', () => {
    const archive = buildTar([{ path: 'a.md', content: 'x'.repeat(2000) }])
    expect(() => readTar(archive.subarray(0, 1024))).toThrow('Truncated tar archive')
  })
})

describe('parseFrontmatter', () => {
  it('passes every field through as JSON', () => {
    const result = parseFrontmatter(
      '---\nname: refunds\ndescription: >\n  Process refunds\nlicense: Apache-2.0\nmetadata:\n  version: 2\n---\nBody'
    )
    expect(result).toEqual({
      ok: true,
      frontmatter: {
        name: 'refunds',
        description: 'Process refunds\n',
        license: 'Apache-2.0',
        metadata: { version: 2 }
      }
    })
  })

  it('rejects markdown without frontmatter, non-mappings and missing fields', () => {
    expect(parseFrontmatter('# No frontmatter').ok).toBe(false)
    expect(parseFrontmatter('---\n- a\n---\n').ok).toBe(false)
    expect(parseFrontmatter('---\nname: x\n---\n').ok).toBe(false)
    expect(parseFrontmatter('---\nname: [unclosed\n---\n').ok).toBe(false)
  })
})

describe('buildSkill', () => {
  it('publishes a complete manifest whose digests and sizes match the served bytes', async () => {
    const skillMd = skillMarkdown('wrangler', 'Use Wrangler')
    const script = '#!/bin/sh\necho hi\n'
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x01])

    const result = await buildSkill('wrangler', [
      { path: 'scripts/run.sh', bytes: bytes(script) },
      { path: 'assets/logo.png', bytes: binary },
      { path: 'SKILL.md', bytes: bytes(skillMd) }
    ])

    if (!result.ok) throw new Error(result.reason)
    expect(result.skill.uri).toBe('skill://wrangler/SKILL.md')
    expect(result.skill.frontmatter).toEqual({ name: 'wrangler', description: 'Use Wrangler' })
    expect(result.skill.resources).toEqual([
      {
        uri: 'skill://wrangler/SKILL.md',
        digest: `sha256:${await sha256Hex(bytes(skillMd))}`,
        size: bytes(skillMd).byteLength
      },
      {
        uri: 'skill://wrangler/assets/logo.png',
        digest: `sha256:${await sha256Hex(binary)}`,
        size: 4
      },
      {
        uri: 'skill://wrangler/scripts/run.sh',
        digest: `sha256:${await sha256Hex(bytes(script))}`,
        size: bytes(script).byteLength
      }
    ])
    expect(result.files).toEqual([
      { uri: 'skill://wrangler/SKILL.md', mimeType: 'text/markdown', text: skillMd },
      {
        uri: 'skill://wrangler/assets/logo.png',
        mimeType: 'image/png',
        blob: btoa('\xff\xfe\x00\x01')
      },
      { uri: 'skill://wrangler/scripts/run.sh', mimeType: 'text/x-shellscript', text: script }
    ])
  })

  it('percent-encodes path segments in file URIs', async () => {
    const result = await buildSkill('docs', [
      { path: 'SKILL.md', bytes: bytes(skillMarkdown('docs', 'Docs')) },
      { path: 'references/a b#c.md', bytes: bytes('x') }
    ])
    if (!result.ok) throw new Error(result.reason)
    expect(result.skill.resources[1]?.uri).toBe('skill://docs/references/a%20b%23c.md')
  })

  it.each([
    [
      'an invalid directory name',
      'Bad_Name',
      [{ path: 'SKILL.md', bytes: bytes(skillMarkdown('Bad_Name', 'x')) }]
    ],
    ['no SKILL.md', 'docs', [{ path: 'README.md', bytes: bytes('x') }]],
    ['a name mismatch', 'docs', [{ path: 'SKILL.md', bytes: bytes(skillMarkdown('other', 'x')) }]],
    [
      'an empty description',
      'docs',
      [{ path: 'SKILL.md', bytes: bytes(skillMarkdown('docs', '""')) }]
    ],
    [
      'too many files',
      'docs',
      [
        { path: 'SKILL.md', bytes: bytes(skillMarkdown('docs', 'x')) },
        ...Array.from({ length: MAX_RESOURCES_PER_SKILL }, (_, index) => ({
          path: `f${index}.md`,
          bytes: bytes('x')
        }))
      ]
    ]
  ])('skips a skill with %s', async (_case, name, files) => {
    const result = await buildSkill(name, files)
    expect(result.ok).toBe(false)
  })
})

describe('buildSkillsBundle', () => {
  it('groups skills/<name>/ directories and reports the ones it skips', async () => {
    const { bundle, skipped } = await buildSkillsBundle(
      [
        { path: 'README.md', bytes: bytes('repo readme') },
        { path: 'skills/wrangler/SKILL.md', bytes: bytes(skillMarkdown('wrangler', 'Wrangler')) },
        { path: 'skills/wrangler/references/a.md', bytes: bytes('a') },
        { path: 'skills/broken/notes.md', bytes: bytes('no skill file') },
        { path: 'skills/wrangler/../escape.md', bytes: bytes('x') }
      ],
      { repository: 'cloudflare/skills', commit: null },
      new Date('2026-10-08T00:00:00Z')
    )

    expect(bundle.syncedAt).toBe('2026-10-08T00:00:00.000Z')
    expect(bundle.skills.map(({ skill }) => skill.uri)).toEqual(['skill://wrangler/SKILL.md'])
    expect(bundle.skills[0]?.skill.resources.map((resource) => resource.uri)).toEqual([
      'skill://wrangler/SKILL.md',
      'skill://wrangler/references/a.md'
    ])
    expect(skipped).toEqual([{ name: 'broken', reason: 'No SKILL.md at the skill root' }])
  })
})

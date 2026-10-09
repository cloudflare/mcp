import { env, exports } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mockIdentityProbe } from '../helpers/cloudflare-api'
import { clearKv } from '../helpers/kv'
import { MCP_HOST, MCP_URL, modernMcpRequest, parseMcpResult } from '../helpers/mcp'
import { clearSpec, seedSpec } from '../helpers/spec'
import { seedSkills, skillMarkdown } from '../helpers/skills'
import { SKILL_FILES_PREFIX } from '../../src/skills/types'

/**
 * Drives the real worker through `exports.default.fetch`: auth, the MCP
 * transport and the skills handlers all run for real. The skills catalog comes
 * from running the real daily sync over an archive served by MSW.
 */

const API_TOKEN = 'skills-mcp-token'
const ACCOUNT_ID = '00000000000000000000000000000001'

const WRANGLER_SKILL_MD = skillMarkdown('wrangler', 'Use the Wrangler CLI', '# Wrangler\n')
const SCRIPT = '#!/bin/sh\necho deploy\n'
const LOGO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00])

interface SkillEntry {
  uri: string
  frontmatter: Record<string, unknown>
  resources: Array<{ uri: string; digest: string; size: number }>
}

interface JsonRpcBody {
  result?: Record<string, unknown> & {
    skills?: SkillEntry[]
    skill?: SkillEntry
    contents?: Array<{ uri: string; mimeType: string; text?: string }>
    resources?: Array<{ uri: string; name: string; description?: string }>
    capabilities?: { resources?: unknown; extensions?: Record<string, unknown> }
  }
  error?: { code: number; message: string }
}

async function modern(
  method: string,
  params: Record<string, unknown> = {},
  url = MCP_URL
): Promise<JsonRpcBody> {
  const response = await exports.default.fetch(modernMcpRequest(API_TOKEN, method, params, { url }))
  return (await parseMcpResult(response)) as JsonRpcBody
}

/** A 2025-era stateless request: no per-request `_meta` envelope or version header. */
async function legacy(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcBody> {
  const response = await exports.default.fetch(
    new Request(MCP_URL, {
      method: 'POST',
      headers: {
        Host: MCP_HOST,
        Authorization: `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
  )
  return (await parseMcpResult(response)) as JsonRpcBody
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  )
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

beforeEach(async () => {
  // Non-Code-Mode serves tools from the spec artifacts, so seed a minimal spec.
  await seedSpec({})
  mockIdentityProbe({ accounts: [{ id: ACCOUNT_ID, name: 'Skills' }] })
})

afterEach(async () => {
  await clearKv(env.OAUTH_KV)
  await clearSpec()
})

describe('skills extension with a synced catalog', () => {
  beforeEach(async () => {
    await seedSkills({
      'README.md': 'repo readme',
      'skills/wrangler/SKILL.md': WRANGLER_SKILL_MD,
      'skills/wrangler/scripts/deploy.sh': SCRIPT,
      'skills/durable-objects/assets/logo.png': LOGO,
      'skills/durable-objects/SKILL.md': skillMarkdown(
        'durable-objects',
        'Build with Durable Objects'
      )
    })
  })

  it.each([
    ['Code Mode', MCP_URL],
    ['non-Code-Mode', `${MCP_URL}?codemode=false`]
  ])('declares the extension and resources in server/discover (%s)', async (_mode, url) => {
    const body = await modern('server/discover', {}, url)

    expect(body.result?.capabilities?.resources).toEqual({})
    expect(body.result?.capabilities?.extensions).toEqual({ 'io.modelcontextprotocol/skills': {} })
  })

  it('lists every skill as a complete, cacheable manifest', async () => {
    const body = await modern('skills/list')

    expect(body.error).toBeUndefined()
    expect(body.result).toMatchObject({
      resultType: 'complete',
      ttlMs: 3_600_000,
      cacheScope: 'public'
    })
    expect(body.result?.nextCursor).toBeUndefined()
    expect(body.result?.skills).toEqual([
      {
        uri: 'skill://durable-objects/SKILL.md',
        frontmatter: { name: 'durable-objects', description: 'Build with Durable Objects' },
        resources: [
          expect.objectContaining({ uri: 'skill://durable-objects/SKILL.md' }),
          expect.objectContaining({ uri: 'skill://durable-objects/assets/logo.png', size: 6 })
        ]
      },
      {
        uri: 'skill://wrangler/SKILL.md',
        frontmatter: { name: 'wrangler', description: 'Use the Wrangler CLI' },
        resources: [
          {
            uri: 'skill://wrangler/SKILL.md',
            digest: await sha256(WRANGLER_SKILL_MD),
            size: WRANGLER_SKILL_MD.length
          },
          {
            uri: 'skill://wrangler/scripts/deploy.sh',
            digest: await sha256(SCRIPT),
            size: SCRIPT.length
          }
        ]
      }
    ])
  })

  it('serves files whose bytes match the digests in skills/get', async () => {
    const { result } = await modern('skills/get', { uri: 'skill://wrangler/SKILL.md' })
    expect(result).toMatchObject({ resultType: 'complete', ttlMs: 3_600_000, cacheScope: 'public' })

    for (const resource of result?.skill?.resources ?? []) {
      const read = await modern('resources/read', { uri: resource.uri })
      const text = read.result?.contents?.[0]?.text ?? ''
      expect(await sha256(text)).toBe(resource.digest)
      expect(new TextEncoder().encode(text).byteLength).toBe(resource.size)
    }

    const script = await modern('resources/read', { uri: 'skill://wrangler/scripts/deploy.sh' })
    expect(script.result?.contents).toEqual([
      { uri: 'skill://wrangler/scripts/deploy.sh', mimeType: 'text/x-shellscript', text: SCRIPT }
    ])
  })

  it('serves binary files as base64 blobs', async () => {
    const body = await modern('resources/read', { uri: 'skill://durable-objects/assets/logo.png' })

    expect(body.result?.contents).toEqual([
      {
        uri: 'skill://durable-objects/assets/logo.png',
        mimeType: 'image/png',
        blob: btoa(String.fromCharCode(...LOGO))
      }
    ])
  })

  it('answers -32603 when R2 no longer holds a file the cached manifest names', async () => {
    const { objects } = await env.SPEC_BUCKET.list({ prefix: SKILL_FILES_PREFIX })
    await env.SPEC_BUCKET.delete(objects.map((object) => object.key))

    const body = await modern('resources/read', { uri: 'skill://wrangler/scripts/deploy.sh' })
    expect(body.error?.code).toBe(-32603)
  })

  it('lists only SKILL.md files in resources/list', async () => {
    const body = await modern('resources/list')

    expect(body.result?.resources).toEqual([
      {
        uri: 'skill://durable-objects/SKILL.md',
        name: 'durable-objects',
        description: 'Build with Durable Objects',
        mimeType: 'text/markdown'
      },
      {
        uri: 'skill://wrangler/SKILL.md',
        name: 'wrangler',
        description: 'Use the Wrangler CLI',
        mimeType: 'text/markdown'
      }
    ])
  })

  it.each([
    ['skills/get with an unknown skill', 'skills/get', { uri: 'skill://missing/SKILL.md' }],
    [
      'skills/get with a supporting file',
      'skills/get',
      { uri: 'skill://wrangler/scripts/deploy.sh' }
    ],
    ['resources/read with an unknown file', 'resources/read', { uri: 'skill://wrangler/nope.md' }],
    ['skills/list with a cursor this server never issued', 'skills/list', { cursor: 'abc' }]
  ])('answers %s with -32602', async (_case, method, params) => {
    const body = await modern(method, params)
    expect(body.error?.code).toBe(-32602)
  })

  it('serves 2025-era stateless clients too', async () => {
    const list = await legacy('skills/list')
    expect(list.result?.skills?.map((skill) => skill.uri)).toEqual([
      'skill://durable-objects/SKILL.md',
      'skill://wrangler/SKILL.md'
    ])

    const read = await legacy('resources/read', { uri: 'skill://wrangler/SKILL.md' })
    expect(read.result?.contents?.[0]?.text).toBe(WRANGLER_SKILL_MD)
  })
})

describe('skills extension before the first sync', () => {
  it('returns an empty listing rather than failing', async () => {
    const body = await modern('skills/list')
    expect(body.error).toBeUndefined()
    expect(body.result?.skills).toEqual([])
  })
})

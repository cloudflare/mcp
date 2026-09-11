import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ErrorCode, McpError, RequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type {
  ListResourcesResult,
  ReadResourceResult,
  Resource
} from '@modelcontextprotocol/sdk/types.js'

const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills'
const SKILL_URI_PREFIX = 'skill://'
const INDEX_URI = 'skill://index.json'
const TREE_ARTIFACT = '.tree.json'
const DEFAULT_SKILLS_BASE_URL = 'https://developers.cloudflare.com/.well-known/mcp/skills'
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000
const DIRECTORY_PAGE_SIZE = 200

const DirectoryReadRequestSchema = RequestSchema.extend({
  method: z.literal('resources/directory/read'),
  params: z
    .object({
      uri: z.string(),
      cursor: z.string().optional(),
      _meta: z.object({}).passthrough().optional()
    })
    .passthrough()
})

type Fetcher = typeof fetch

type SkillFrontmatter = Record<string, unknown> & {
  name: string
  description: string
}

type SkillArchiveEntry = {
  url: string
  mimeType: string
  digest: string
}

type SkillIndex = {
  skills: Array<{
    url?: string
    digest?: string
    frontmatter: SkillFrontmatter
    archives?: SkillArchiveEntry[]
  }>
}

type TreeDirectoryEntry = {
  mimeType: 'inode/directory'
  name: string
  path: string
  type: 'directory'
  uri: string
}

type TreeFileEntry = {
  description?: string
  digest: string
  mimeType: string
  name: string
  path: string
  size: number
  type: 'file'
  uri: string
  _meta?: Record<string, unknown>
}

type TreeEntry = TreeDirectoryEntry | TreeFileEntry

type SkillTree = {
  entries: TreeEntry[]
}

type CacheEntry<T> = {
  expiresAt: number
  value: T
}

export type CloudflareSkillsProviderOptions = {
  baseUrl?: string
  fetcher?: Fetcher
  cacheTtlMs?: number
}

export class CloudflareSkillsProvider {
  private readonly baseUrl: string
  private readonly fetcher: Fetcher
  private readonly cacheTtlMs: number
  private indexCache?: CacheEntry<SkillIndex>
  private treeCache?: CacheEntry<SkillTree>
  private readonly fileCache = new Map<string, CacheEntry<Uint8Array>>()

  constructor(options: CloudflareSkillsProviderOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_SKILLS_BASE_URL).replace(/\/+$/, '')
    this.fetcher = options.fetcher ?? fetch
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  }

  async readIndex(uri = INDEX_URI): Promise<ReadResourceResult> {
    const index = await this.getIndex()
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(index, null, 2)
        }
      ]
    }
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    const skillPath = parseSkillUriPath(uri)
    if (skillPath === 'index.json') {
      return this.readIndex(uri)
    }
    if (skillPath === TREE_ARTIFACT) {
      throw invalidParams(`Resource ${uri} not found`)
    }

    const archive = await this.getArchiveEntry(skillPath)
    const resource = archive ?? (await this.getFileEntry(skillPath, uri))
    const bytes = await this.fetchFile(skillPath)
    const content = {
      uri,
      mimeType: resource.mimeType,
      ...(isTextMimeType(resource.mimeType)
        ? { text: new TextDecoder().decode(bytes) }
        : { blob: uint8ArrayToBase64(bytes) })
    }

    return { contents: [content] }
  }

  async readDirectory(uri: string, cursor?: string): Promise<ListResourcesResult> {
    const skillPath = parseSkillUriPath(uri)
    if (skillPath === 'index.json' || skillPath === TREE_ARTIFACT) {
      throw invalidParams(`Directory ${uri} not found`)
    }

    const tree = await this.getTree()
    const directory = tree.entries.find(
      (entry) => entry.type === 'directory' && entry.path === skillPath
    )
    if (!directory) {
      throw invalidParams(`Directory ${uri} not found`)
    }

    const childPrefix = `${directory.path}/`
    const childEntries = tree.entries
      .filter((entry) => entry.path.startsWith(childPrefix))
      .filter((entry) => !entry.path.slice(childPrefix.length).includes('/'))
      .sort((a, b) => a.path.localeCompare(b.path))

    return paginateResources(childEntries.map(resourceForTreeEntry), cursor)
  }

  private async getIndex(): Promise<SkillIndex> {
    const cached = getFreshCacheValue(this.indexCache)
    if (cached) {
      return cached
    }

    const index = await this.fetchJson<SkillIndex>('index.json')
    assertSkillIndex(index)
    this.indexCache = this.cache(index)
    return index
  }

  private async getTree(): Promise<SkillTree> {
    const cached = getFreshCacheValue(this.treeCache)
    if (cached) {
      return cached
    }

    const tree = await this.fetchJson<SkillTree>(TREE_ARTIFACT)
    assertSkillTree(tree)
    this.treeCache = this.cache(tree)
    return tree
  }

  private async getFileEntry(skillPath: string, uri: string): Promise<TreeFileEntry> {
    const tree = await this.getTree()
    const entry = tree.entries.find(
      (item): item is TreeFileEntry => item.type === 'file' && item.path === skillPath
    )
    if (!entry) {
      throw invalidParams(`Resource ${uri} not found`)
    }
    return entry
  }

  private async getArchiveEntry(skillPath: string): Promise<SkillArchiveEntry | undefined> {
    const index = await this.getIndex()
    for (const skill of index.skills) {
      for (const archive of skill.archives ?? []) {
        try {
          if (parseSkillUriPath(archive.url) === skillPath) {
            return archive
          }
        } catch {
          continue
        }
      }
    }
    return undefined
  }

  private async fetchJson<T>(artifactPath: string): Promise<T> {
    const response = await this.fetcher(this.artifactUrl(artifactPath), {
      headers: { Accept: 'application/json' }
    })
    if (!response.ok) {
      throw new Error(
        `Failed to fetch Cloudflare skills artifact ${artifactPath}: ${response.status}`
      )
    }

    return (await response.json()) as T
  }

  private async fetchFile(publicPath: string): Promise<Uint8Array> {
    const cached = getFreshCacheValue(this.fileCache.get(publicPath))
    if (cached) {
      return cached
    }

    const response = await this.fetcher(this.artifactUrl(publicPath))
    if (!response.ok) {
      throw new Error(`Failed to fetch Cloudflare skill file ${publicPath}: ${response.status}`)
    }

    const bytes = new Uint8Array(await response.arrayBuffer())
    this.fileCache.set(publicPath, this.cache(bytes))
    return bytes
  }

  private artifactUrl(publicPath: string) {
    const encodedPath = publicPath.split('/').map(encodeURIComponent).join('/')
    return `${this.baseUrl}/${encodedPath}`
  }

  private cache<T>(value: T): CacheEntry<T> {
    return {
      value,
      expiresAt: Date.now() + this.cacheTtlMs
    }
  }
}

const defaultCloudflareSkillsProvider = new CloudflareSkillsProvider()

export function registerCloudflareSkills(
  server: McpServer,
  provider = defaultCloudflareSkillsProvider
) {
  server.server.registerCapabilities({
    extensions: {
      [SKILLS_EXTENSION_ID]: { directoryRead: true }
    }
  } as never)

  server.registerResource(
    'cloudflare-skills-index',
    INDEX_URI,
    {
      title: 'Cloudflare Agent Skills index',
      description: 'Index of Cloudflare Agent Skills served from developers.cloudflare.com.',
      mimeType: 'application/json'
    },
    (uri) => provider.readIndex(uri.toString())
  )

  server.registerResource(
    'cloudflare-skills',
    new ResourceTemplate('skill://{+path}', { list: undefined }),
    {
      title: 'Cloudflare Agent Skills',
      description: 'Cloudflare Agent Skill files served from developers.cloudflare.com.'
    },
    (uri) => provider.readResource(uri.toString())
  )

  server.server.setRequestHandler(DirectoryReadRequestSchema, (request) =>
    provider.readDirectory(request.params.uri, request.params.cursor)
  )
}

function resourceForTreeEntry(entry: TreeEntry): Resource {
  return {
    uri: entry.uri,
    name: entry.name,
    mimeType: entry.mimeType,
    ...(entry.type === 'file' && entry.description ? { description: entry.description } : {}),
    ...(entry.type === 'file' && entry._meta ? { _meta: entry._meta } : {})
  }
}

function parseSkillUriPath(uri: string) {
  if (!uri.startsWith(SKILL_URI_PREFIX)) {
    throw invalidParams(`Unsupported skill URI ${uri}`)
  }
  const withoutScheme = uri.slice(SKILL_URI_PREFIX.length)
  if (withoutScheme.includes('?') || withoutScheme.includes('#')) {
    throw invalidParams(`Unsupported skill URI ${uri}`)
  }

  const rawPath = withoutScheme.replace(/^\/+/, '')
  const segments = rawPath.split('/').filter((segment) => segment.length > 0)
  if (segments.some((segment) => segment === '.' || segment === '..') || segments.length === 0) {
    throw invalidParams(`Unsupported skill URI ${uri}`)
  }

  let decodedSegments: string[]
  try {
    decodedSegments = segments.map((segment) => decodeURIComponent(segment))
  } catch {
    throw invalidParams(`Unsupported skill URI ${uri}`)
  }

  if (
    decodedSegments.some(
      (segment) =>
        segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\')
    )
  ) {
    throw invalidParams(`Unsupported skill URI ${uri}`)
  }

  return decodedSegments.join('/')
}

function isTextMimeType(mimeType: string) {
  const baseMimeType = mimeType.split(';')[0].trim().toLowerCase()
  return (
    baseMimeType.startsWith('text/') ||
    baseMimeType === 'application/json' ||
    baseMimeType === 'application/javascript' ||
    baseMimeType === 'image/svg+xml'
  )
}

function uint8ArrayToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize))
  }
  return btoa(binary)
}

function paginateResources(resources: Resource[], cursor?: string): ListResourcesResult {
  const start = cursor ? Number.parseInt(cursor, 10) : 0
  if (!Number.isInteger(start) || start < 0) {
    throw invalidParams(`Invalid cursor ${cursor}`)
  }

  const page = resources.slice(start, start + DIRECTORY_PAGE_SIZE)
  const nextCursor =
    start + DIRECTORY_PAGE_SIZE < resources.length ? String(start + DIRECTORY_PAGE_SIZE) : undefined

  return {
    resources: page,
    ...(nextCursor ? { nextCursor } : {})
  }
}

function getFreshCacheValue<T>(entry: CacheEntry<T> | undefined) {
  if (entry && entry.expiresAt > Date.now()) {
    return entry.value
  }
  return undefined
}

function assertSkillIndex(value: SkillIndex) {
  if (!value || !Array.isArray(value.skills)) {
    throw new Error('Cloudflare skills index response was invalid')
  }

  for (const skill of value.skills) {
    if (
      !skill ||
      !skill.frontmatter ||
      typeof skill.frontmatter.name !== 'string' ||
      typeof skill.frontmatter.description !== 'string'
    ) {
      throw new Error('Cloudflare skills index response was invalid')
    }

    if (
      (skill.url !== undefined && typeof skill.url !== 'string') ||
      (skill.digest !== undefined && typeof skill.digest !== 'string')
    ) {
      throw new Error('Cloudflare skills index response was invalid')
    }

    if (
      skill.archives !== undefined &&
      (!Array.isArray(skill.archives) ||
        skill.archives.some(
          (archive) =>
            !archive ||
            typeof archive.url !== 'string' ||
            typeof archive.mimeType !== 'string' ||
            typeof archive.digest !== 'string'
        ))
    ) {
      throw new Error('Cloudflare skills index response was invalid')
    }
  }
}

function assertSkillTree(value: SkillTree) {
  if (!value || !Array.isArray(value.entries)) {
    throw new Error('Cloudflare skills tree response was invalid')
  }

  for (const entry of value.entries) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      typeof entry.uri !== 'string' ||
      typeof entry.name !== 'string' ||
      typeof entry.mimeType !== 'string'
    ) {
      throw new Error('Cloudflare skills tree response was invalid')
    }

    if (entry.type === 'file') {
      if (
        typeof entry.digest !== 'string' ||
        typeof entry.size !== 'number' ||
        !entry.uri.startsWith(SKILL_URI_PREFIX)
      ) {
        throw new Error('Cloudflare skills tree response was invalid')
      }
      continue
    }

    if (entry.type !== 'directory' || entry.mimeType !== 'inode/directory') {
      throw new Error('Cloudflare skills tree response was invalid')
    }
  }
}

function invalidParams(message: string) {
  return new McpError(ErrorCode.InvalidParams, message)
}

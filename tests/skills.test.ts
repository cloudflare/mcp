import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from '../src/server'
import { CloudflareSkillsProvider, registerCloudflareSkills } from '../src/skills'
import { clearSpec, seedSpec } from './helpers/spec'

import type { AuthProps } from '../src/auth/types'
import type { ListResourcesResult } from '@modelcontextprotocol/sdk/types.js'
import type { OperationInfo } from '../src/openapi'

const skillsBaseUrl = 'https://developers.cloudflare.com/.well-known/mcp/skills'

const skillText = `---
name: cloudflare
description: Build on Cloudflare.
references:
  - workers
  - d1
---

# Cloudflare
`

const referenceText = '# Workers reference\n'
const archiveBytes = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00])
const archiveBlob = 'H4sIAA=='

const skillFrontmatter = {
  name: 'cloudflare',
  description: 'Build on Cloudflare.',
  references: ['workers', 'd1']
}

const skillDigest = 'sha256:3030303030303030303030303030303030303030303030303030303030303030'

const publishedIndex = {
  skills: [
    {
      url: 'skill://cloudflare/SKILL.md',
      digest: skillDigest,
      frontmatter: skillFrontmatter,
      archives: [
        {
          url: 'skill://cloudflare.tar.gz',
          mimeType: 'application/gzip',
          digest: 'sha256:3232323232323232323232323232323232323232323232323232323232323232'
        }
      ]
    }
  ]
}

const publishedTree = {
  entries: [
    {
      mimeType: 'inode/directory',
      name: 'cloudflare',
      path: 'cloudflare',
      type: 'directory',
      uri: 'skill://cloudflare'
    },
    {
      description: 'Build on Cloudflare.',
      digest: skillDigest,
      mimeType: 'text/markdown',
      name: 'cloudflare',
      path: 'cloudflare/SKILL.md',
      size: skillText.length,
      type: 'file',
      uri: 'skill://cloudflare/SKILL.md',
      _meta: {
        'io.modelcontextprotocol.skills/frontmatter': skillFrontmatter
      }
    },
    {
      mimeType: 'inode/directory',
      name: 'references',
      path: 'cloudflare/references',
      type: 'directory',
      uri: 'skill://cloudflare/references'
    },
    {
      digest: 'sha256:3131313131313131313131313131313131313131313131313131313131313131',
      mimeType: 'text/markdown',
      name: 'workers.md',
      path: 'cloudflare/references/workers.md',
      size: referenceText.length,
      type: 'file',
      uri: 'skill://cloudflare/references/workers.md'
    }
  ]
}

const authProps: AuthProps = {
  type: 'account_token',
  accessToken: 'test-token',
  account: { id: 'test-account', name: 'Test Account' }
}

afterEach(() => clearSpec())

function createProvider() {
  const fetcher: typeof fetch = async (input) => {
    const url = input.toString()
    if (url === `${skillsBaseUrl}/index.json`) {
      return Response.json(publishedIndex)
    }
    if (url === `${skillsBaseUrl}/.tree.json`) {
      return Response.json(publishedTree)
    }
    if (url === `${skillsBaseUrl}/cloudflare/SKILL.md`) {
      return new Response(skillText)
    }
    if (url === `${skillsBaseUrl}/cloudflare/references/workers.md`) {
      return new Response(referenceText)
    }
    if (url === `${skillsBaseUrl}/cloudflare.tar.gz`) {
      return new Response(archiveBytes)
    }
    return new Response('not found', { status: 404 })
  }

  return new CloudflareSkillsProvider({ baseUrl: skillsBaseUrl, fetcher, cacheTtlMs: 0 })
}

async function withClient<T>(
  server: McpServer,
  action: (client: Client) => Promise<T>
): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  try {
    return await action(client)
  } finally {
    await client.close()
    await server.close()
  }
}

describe('CloudflareSkillsProvider', () => {
  it('serves the published SEP-2640 skill index', async () => {
    const provider = createProvider()
    const result = await provider.readIndex()
    const content = result.contents[0]
    if (!('text' in content)) {
      throw new Error('Expected text content')
    }
    const index = JSON.parse(content.text)

    expect(index).toEqual(publishedIndex)
  })

  it('reads published skill files and supporting files through skill URIs', async () => {
    const provider = createProvider()
    const skill = await provider.readResource('skill://cloudflare/SKILL.md')
    const reference = await provider.readResource('skill://cloudflare/references/workers.md')

    expect(skill.contents[0]).toMatchObject({
      uri: 'skill://cloudflare/SKILL.md',
      mimeType: 'text/markdown',
      text: skillText
    })
    expect(reference.contents[0]).toMatchObject({
      uri: 'skill://cloudflare/references/workers.md',
      mimeType: 'text/markdown',
      text: referenceText
    })
  })

  it('reads archive resources advertised by the published index', async () => {
    const provider = createProvider()
    const archive = await provider.readResource('skill://cloudflare.tar.gz')

    expect(archive.contents[0]).toMatchObject({
      uri: 'skill://cloudflare.tar.gz',
      mimeType: 'application/gzip',
      blob: archiveBlob
    })
  })

  it('lists direct children from the published tree manifest', async () => {
    const provider = createProvider()
    const result = await provider.readDirectory('skill://cloudflare')

    expect(result.resources).toEqual([
      {
        uri: 'skill://cloudflare/references',
        name: 'references',
        mimeType: 'inode/directory'
      },
      {
        uri: 'skill://cloudflare/SKILL.md',
        name: 'cloudflare',
        description: 'Build on Cloudflare.',
        mimeType: 'text/markdown',
        _meta: {
          'io.modelcontextprotocol.skills/frontmatter': skillFrontmatter
        }
      }
    ])
  })
})

describe('registerCloudflareSkills', () => {
  it('advertises the skills extension and registers resource handlers', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' })
    registerCloudflareSkills(server, createProvider())

    expect(
      (server.server as unknown as { getCapabilities(): unknown }).getCapabilities()
    ).toMatchObject({
      extensions: {
        'io.modelcontextprotocol/skills': { directoryRead: true }
      },
      resources: {
        listChanged: true
      }
    })

    await withClient(server, async (client) => {
      // SDK 1.26's client schema predates capabilities.extensions and strips it
      // during parsing; the raw server capability object above still advertises it.
      expect(client.getServerCapabilities()).toMatchObject({
        resources: {
          listChanged: true
        }
      })

      const resources = await client.listResources()
      expect(resources.resources).toEqual([
        expect.objectContaining({
          uri: 'skill://index.json',
          name: 'cloudflare-skills-index',
          mimeType: 'application/json'
        })
      ])

      const index = await client.readResource({ uri: 'skill://index.json' })
      const content = index.contents[0]
      if (!('text' in content)) {
        throw new Error('Expected text content')
      }
      expect(JSON.parse(content.text).skills[0].url).toBe('skill://cloudflare/SKILL.md')

      const skill = await client.readResource({ uri: 'skill://cloudflare/SKILL.md' })
      expect(skill.contents[0]).toMatchObject({
        uri: 'skill://cloudflare/SKILL.md',
        mimeType: 'text/markdown',
        text: skillText
      })
    })
  })

  it('registers the resources/directory/read extension method', async () => {
    const server = new McpServer({ name: 'test', version: '1.0.0' })
    registerCloudflareSkills(server, createProvider())

    const handlers = (
      server.server as unknown as {
        _requestHandlers: Map<
          string,
          (request: unknown, extra: unknown) => Promise<ListResourcesResult>
        >
      }
    )._requestHandlers

    const result = await handlers.get('resources/directory/read')?.(
      {
        method: 'resources/directory/read',
        params: { uri: 'skill://cloudflare/references' }
      },
      {}
    )

    expect(result).toEqual({
      resources: [
        {
          uri: 'skill://cloudflare/references/workers.md',
          name: 'workers.md',
          mimeType: 'text/markdown'
        }
      ]
    })
  })
})

describe('createServer skills registration', () => {
  it('registers Cloudflare skills only for code mode', async () => {
    await seedSpec({
      '/accounts/{account_id}/workers/scripts': {
        get: { summary: 'List Workers' } as OperationInfo
      }
    })

    const codeModeServer = await createServer(authProps)
    const nonCodeModeServer = await createServer(authProps, false)

    const codeModeResources = (codeModeServer as unknown as { _registeredResources: object })
      ._registeredResources
    const nonCodeModeResources = (nonCodeModeServer as unknown as { _registeredResources: object })
      ._registeredResources

    expect(codeModeResources).toHaveProperty('skill://index.json')
    expect(nonCodeModeResources).not.toHaveProperty('skill://index.json')
  })
})

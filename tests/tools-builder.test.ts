import { env, exports } from 'cloudflare:workers'
import { createScheduledController } from 'cloudflare:test'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { clearR2 } from './helpers/r2'
import { server } from './setup/msw'
import worker from '../src/index'
import { FORGE_LATEST_URL, latestForgeSpec } from '../src/forge-source'

/**
 * The daily build runs the generator in a container, which the workers pool
 * can't start. These cover everything around it for real: the container's
 * only egress (`BuildEgress`, called through the real `ctx.exports` loopback),
 * the Forge download (GitHub mocked with MSW), R2 writes (real SPEC_BUCKET),
 * and the scheduled handler's dispatch to the ToolsBuilder Durable Object.
 */

const RELEASE = 'openapi@0123456789abcdef'
const ASSET_URL = `https://github.com/cloudflare/forge/releases/download/${RELEASE}/openapi.forge.json`
const SIGNED_URL = 'https://release-assets.githubusercontent.com/asset?sig=1'
const DOCUMENT = { openapi: '3.0.3', paths: {} }

function serveForge() {
  server.use(
    http.get(
      FORGE_LATEST_URL,
      () => new HttpResponse(null, { status: 302, headers: { location: ASSET_URL } })
    ),
    http.get(
      ASSET_URL,
      () => new HttpResponse(null, { status: 302, headers: { location: SIGNED_URL } })
    ),
    http.get(SIGNED_URL.split('?')[0]!, () => HttpResponse.json(DOCUMENT))
  )
}

const egress = () => exports.BuildEgress({ props: {} })

afterEach(() => clearR2(env.SPEC_BUCKET))

describe('latestForgeSpec', () => {
  it('follows the latest-release redirect and names the release', async () => {
    serveForge()

    const response = await latestForgeSpec(fetch)

    expect(response.headers.get('x-forge-release')).toBe(RELEASE)
    expect(await response.json()).toEqual(DOCUMENT)
  })

  it('fails when GitHub does not redirect to a release asset', async () => {
    server.use(http.get(FORGE_LATEST_URL, () => new HttpResponse('nope', { status: 404 })))

    await expect(latestForgeSpec(fetch)).rejects.toThrow('did not redirect to a release (404)')
  })

  it('fails when the asset download fails', async () => {
    server.use(
      http.get(
        FORGE_LATEST_URL,
        () => new HttpResponse(null, { status: 302, headers: { location: ASSET_URL } })
      ),
      http.get(ASSET_URL, () => new HttpResponse('gone', { status: 502 }))
    )

    await expect(latestForgeSpec(fetch)).rejects.toThrow(`GET ${ASSET_URL} failed: 502`)
  })
})

describe('BuildEgress', () => {
  it('serves the newest Forge document to the container', async () => {
    serveForge()

    const response = await egress().fetch('http://forge.internal/openapi.forge.json')

    expect(response.status).toBe(200)
    expect(response.headers.get('x-forge-release')).toBe(RELEASE)
    expect(await response.json()).toEqual(DOCUMENT)
  })

  it.each(['spec.json', 'products.json', 'mcp-tools.json'])(
    'stores %s in SPEC_BUCKET',
    async (key) => {
      const response = await egress().fetch(`http://artifacts.internal/${key}`, {
        method: 'PUT',
        headers: { 'x-forge-release': RELEASE },
        body: '{"ok":true}'
      })

      expect(response.status).toBe(204)
      const object = await env.SPEC_BUCKET.get(key)
      expect(await object!.text()).toBe('{"ok":true}')
      expect(object!.httpMetadata?.contentType).toBe('application/json')
      expect(object!.customMetadata).toEqual({ forgeRelease: RELEASE })
    }
  )

  it.each([
    ['an unknown artifact', 'http://artifacts.internal/other.json', 'PUT'],
    ['a nested key', 'http://artifacts.internal/builds/spec.json', 'PUT'],
    ['a read of an artifact', 'http://artifacts.internal/spec.json', 'GET'],
    ['another Forge path', 'http://forge.internal/other', 'GET'],
    ['a write to the Forge host', 'http://forge.internal/openapi.forge.json', 'PUT'],
    ['any other host', 'http://example.com/spec.json', 'PUT']
  ])('refuses %s', async (_, url, method) => {
    const response = await egress().fetch(url, {
      method,
      ...(method === 'PUT' ? { body: 'x' } : {})
    })

    expect(response.status).toBe(403)
    expect(await env.SPEC_BUCKET.list()).toMatchObject({ objects: [] })
  })
})

describe('scheduled', () => {
  it('runs one build in the daily ToolsBuilder instance and fetches nothing itself', async () => {
    // The pool has no container runtime, so the namespace is a stand-in.
    // MSW fails any unmocked fetch, so a stray GitHub request would fail too.
    const builds: string[] = []
    const namespace = {
      getByName: (name: string) => ({
        build: async () => {
          builds.push(name)
          return '{"release":"openapi@x","tools":1,"products":1}'
        }
      })
    }
    const controller = createScheduledController({ scheduledTime: Date.now(), cron: '0 0 * * *' })

    await worker.scheduled!(controller, {
      ...env,
      TOOLS_BUILDER: namespace as unknown as Env['TOOLS_BUILDER']
    })

    expect(builds).toEqual(['daily'])
  })
})

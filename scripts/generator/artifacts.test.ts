import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ForgeOpenApiDocument } from '@cloudflare/forge'
import { ARTIFACT_KEYS } from '../../src/mcp-tools.ts'
import { buildArtifacts } from './artifacts.ts'

const source: ForgeOpenApiDocument = {
  openapi: '3.0.3',
  info: { title: 'Widgets', version: '1' },
  components: { schemas: {} },
  paths: {
    '/accounts/{account_id}/widgets': {
      get: {
        operationId: 'list-widgets',
        summary: 'List widgets',
        responses: { '200': { description: 'OK' } },
        'x-fern-sdk-group-name': ['widgets'],
        'x-fern-sdk-method-name': 'list'
      }
    }
  }
} as ForgeOpenApiDocument

test('builds every artifact the Worker reads from one Forge document', async () => {
  const artifacts = await buildArtifacts(source, [])

  assert.deepEqual(Object.keys(artifacts.files).sort(), [...ARTIFACT_KEYS].sort())
  assert.equal(artifacts.tools, 1)
  assert.equal(artifacts.products, 1)
  assert.deepEqual(JSON.parse(artifacts.files['products.json']), ['widgets'])
  assert.equal(JSON.parse(artifacts.files['mcp-tools.json']).tools[0].name, 'widgets_list')
  assert.deepEqual(Object.keys(JSON.parse(artifacts.files['spec.json']).paths), [
    '/accounts/{account_id}/widgets'
  ])
})

test('refuses to publish an empty catalogue', async () => {
  await assert.rejects(
    buildArtifacts({ ...source, paths: {} } as ForgeOpenApiDocument, []),
    /Generator emitted no tools/
  )
})

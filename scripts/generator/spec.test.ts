import assert from 'node:assert/strict'
import { test } from 'node:test'
import { processSpec, productOf, resolveRefs } from './spec.ts'

test('names the product after the first Forge SDK group', () => {
  assert.equal(
    productOf('/zones/{zone_id}/dns_records', { 'x-fern-sdk-group-name': ['dns', 'records'] }),
    'dns'
  )
  assert.equal(
    productOf('/accounts/{account_id}/x', { 'x-fern-sdk-group-name': 'zero-trust.dex' }),
    'zero-trust'
  )
})

test('falls back to the path segment after the account or zone', () => {
  assert.equal(productOf('/accounts/{account_id}/workers/scripts', {}), 'workers')
  assert.equal(productOf('/zones/{zone_id}/dns_records', {}), 'dns_records')
  assert.equal(productOf('/user', {}), undefined)
})

test('resolves refs, including circular ones, without touching primitives', () => {
  const spec = {
    components: {
      schemas: {
        Name: { type: 'string' },
        Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } }
      }
    }
  }
  assert.equal(resolveRefs('x', spec), 'x')
  assert.deepEqual(resolveRefs([{ $ref: '#/components/schemas/Name' }], spec), [{ type: 'string' }])
  const node = resolveRefs({ $ref: '#/components/schemas/Node' }, spec) as any
  assert.equal(node.properties.child.$circular, '#/components/schemas/Node')
})

test('builds the search spec and products from one pass over the document', () => {
  const { spec, products } = processSpec({
    components: { schemas: { Body: { type: 'object', properties: { name: { type: 'string' } } } } },
    paths: {
      '/accounts/{account_id}/workers/scripts': {
        get: {
          summary: 'List Workers',
          tags: ['Workers Scripts'],
          'x-fern-sdk-group-name': ['workers', 'scripts']
        },
        post: {
          summary: 'Create Worker',
          tags: ['workers'],
          'x-fern-sdk-group-name': ['workers', 'scripts'],
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Body' } } }
          }
        }
      },
      '/zones/{zone_id}/dns_records': {
        get: { summary: 'List DNS records', 'x-fern-sdk-group-name': ['dns', 'records'] }
      },
      '/user': { get: { summary: 'User' } }
    }
  })

  assert.deepEqual(products, ['workers', 'dns'])
  const list = spec.paths['/accounts/{account_id}/workers/scripts']!.get as any
  assert.deepEqual(list.tags, ['workers', 'Workers Scripts'])
  const create = spec.paths['/accounts/{account_id}/workers/scripts']!.post as any
  assert.deepEqual(create.tags, ['workers'])
  assert.deepEqual(create.requestBody.content['application/json'].schema, {
    type: 'object',
    properties: { name: { type: 'string' } }
  })
  // Forge extensions stay out of the search spec.
  assert.equal('x-fern-sdk-group-name' in list, false)
  assert.deepEqual((spec.paths['/user']!.get as any).tags, [])
})

test('handles documents without paths', () => {
  assert.deepEqual(processSpec({}), { spec: { paths: {} }, products: [] })
})

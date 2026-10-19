import { describe, it, expect } from 'vitest'
import { extractProduct, resolveRefs, processSpec, extractProducts } from '../src/spec-processor'

describe('extractProduct', () => {
  it('should extract product from account paths', () => {
    expect(extractProduct('/accounts/{account_id}/workers/scripts')).toBe('workers')
  })

  it('should extract product from zone paths', () => {
    expect(extractProduct('/zones/{zone_id}/dns_records')).toBe('dns_records')
  })

  it('should return undefined for paths without account or zone', () => {
    expect(extractProduct('/client/v4/graphql')).toBeUndefined()
  })

  it('should extract first segment after account_id', () => {
    expect(extractProduct('/accounts/{account_id}/d1/database')).toBe('d1')
  })
})

describe('resolveRefs', () => {
  it('should return primitives unchanged', () => {
    expect(resolveRefs('hello', {})).toBe('hello')
    expect(resolveRefs(42, {})).toBe(42)
    expect(resolveRefs(null, {})).toBe(null)
    expect(resolveRefs(undefined, {})).toBe(undefined)
  })

  it('should resolve $ref pointers', () => {
    const spec = {
      components: {
        schemas: {
          MyType: { type: 'string', description: 'A string type' }
        }
      }
    }
    const ref = { $ref: '#/components/schemas/MyType' }
    expect(resolveRefs(ref, spec)).toEqual({ type: 'string', description: 'A string type' })
  })

  it('should handle circular refs', () => {
    const spec = {
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: {
              child: { $ref: '#/components/schemas/Node' }
            }
          }
        }
      }
    }
    const result = resolveRefs(spec.components.schemas.Node, spec) as any
    expect(result.type).toBe('object')
    // First resolution expands the ref, second encounter is marked circular
    expect(result.properties.child.type).toBe('object')
    expect(result.properties.child.properties.child.$circular).toBe('#/components/schemas/Node')
  })

  it('should resolve refs in arrays', () => {
    const spec = {
      components: {
        schemas: {
          Str: { type: 'string' }
        }
      }
    }
    const arr = [{ $ref: '#/components/schemas/Str' }, { type: 'number' }]
    const result = resolveRefs(arr, spec) as any[]
    expect(result[0]).toEqual({ type: 'string' })
    expect(result[1]).toEqual({ type: 'number' })
  })

  it('should resolve nested refs in objects', () => {
    const spec = {
      components: {
        schemas: {
          Inner: { type: 'boolean' }
        }
      }
    }
    const obj = { outer: { inner: { $ref: '#/components/schemas/Inner' } } }
    const result = resolveRefs(obj, spec) as any
    expect(result.outer.inner).toEqual({ type: 'boolean' })
  })
})

describe('processSpec', () => {
  it('should process a minimal spec', () => {
    const rawSpec = {
      paths: {
        '/accounts/{account_id}/workers/scripts': {
          get: {
            summary: 'List Workers',
            description: 'Lists all Workers',
            tags: ['Workers Scripts'],
            parameters: [],
            responses: { '200': { description: 'OK' } }
          }
        }
      }
    }

    const result = processSpec(rawSpec)
    expect(result.paths).toBeDefined()

    const path = result.paths['/accounts/{account_id}/workers/scripts']
    expect(path.get).toBeDefined()

    const op = path.get as any
    expect(op.summary).toBe('List Workers')
    expect(op.tags).toContain('workers')
    expect(op.tags).toContain('Workers Scripts')
  })

  it('should not duplicate product tag if already present', () => {
    const rawSpec = {
      paths: {
        '/accounts/{account_id}/workers/scripts': {
          get: {
            summary: 'List Workers',
            tags: ['workers']
          }
        }
      }
    }

    const result = processSpec(rawSpec)
    const op = result.paths['/accounts/{account_id}/workers/scripts'].get as any
    const workersTags = op.tags.filter((t: string) => t.toLowerCase() === 'workers')
    expect(workersTags).toHaveLength(1)
  })

  it('should resolve $refs in parameters and requestBody', () => {
    const rawSpec = {
      components: {
        schemas: {
          WorkerName: { type: 'string', description: 'Worker name' }
        }
      },
      paths: {
        '/accounts/{account_id}/workers/scripts': {
          post: {
            summary: 'Create Worker',
            tags: [],
            parameters: [
              { name: 'name', in: 'path', schema: { $ref: '#/components/schemas/WorkerName' } }
            ],
            requestBody: {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WorkerName' }
                }
              }
            },
            responses: {}
          }
        }
      }
    }

    const result = processSpec(rawSpec)
    const op = result.paths['/accounts/{account_id}/workers/scripts'].post as any
    expect(op.parameters[0].schema).toEqual({ type: 'string', description: 'Worker name' })
    expect(op.requestBody.content['application/json'].schema).toEqual({
      type: 'string',
      description: 'Worker name'
    })
  })

  it('should handle empty paths', () => {
    const result = processSpec({ paths: {} })
    expect(result.paths).toEqual({})
  })

  it('should handle spec with no paths key', () => {
    const result = processSpec({})
    expect(result.paths).toEqual({})
  })

  it('keeps x-api-token-group lists and drops malformed values', () => {
    const result = processSpec({
      paths: {
        '/zones/{zone_id}/dns_records': {
          get: { summary: 'List', 'x-api-token-group': ['DNS Read', 'DNS Write'] },
          post: { summary: 'Create', 'x-api-token-group': 'DNS Write' },
          put: { summary: 'Replace', 'x-api-token-group': ['DNS Write', ''] }
        }
      }
    })
    const item = result.paths['/zones/{zone_id}/dns_records'] as Record<string, any>
    expect(item.get['x-api-token-group']).toEqual(['DNS Read', 'DNS Write'])
    expect(item.post['x-api-token-group']).toBeUndefined()
    expect(item.put['x-api-token-group']).toBeUndefined()
  })
})

describe('extractProducts', () => {
  it('should extract products sorted by frequency', () => {
    const spec = {
      paths: {
        '/accounts/{account_id}/workers/scripts': {},
        '/accounts/{account_id}/workers/routes': {},
        '/accounts/{account_id}/d1/database': {}
      }
    }

    const products = extractProducts(spec)
    expect(products[0]).toBe('workers') // 2 occurrences
    expect(products[1]).toBe('d1') // 1 occurrence
    expect(products).toHaveLength(2)
  })

  it('should return empty array for spec with no paths', () => {
    expect(extractProducts({})).toEqual([])
  })
})

describe('Forge account-or-zone paths', () => {
  const merged = {
    paths: {
      '/{account_or_zone}/{account_or_zone_id}/access/apps/{app_id}': {
        get: {
          summary: 'Get an Access application',
          parameters: [
            { name: 'account_or_zone', in: 'path', required: true, schema: { type: 'string' } },
            { $ref: '#/components/parameters/account_or_zone_id' },
            { name: 'app_id', in: 'path', required: true, schema: { type: 'string' } }
          ]
        }
      }
    },
    components: {
      parameters: {
        account_or_zone_id: {
          name: 'account_or_zone_id',
          in: 'path',
          required: true,
          schema: { type: 'string', description: 'Identifier.' }
        }
      }
    }
  }

  it('splits a merged path into its account and zone paths', () => {
    const { paths } = processSpec(merged)

    expect(Object.keys(paths)).toEqual([
      '/accounts/{account_id}/access/apps/{app_id}',
      '/zones/{zone_id}/access/apps/{app_id}'
    ])
    const names = (path: string) =>
      (paths[path].get as { parameters: Array<{ name: string }> }).parameters.map((p) => p.name)
    expect(names('/accounts/{account_id}/access/apps/{app_id}')).toEqual(['account_id', 'app_id'])
    expect(names('/zones/{zone_id}/access/apps/{app_id}')).toEqual(['zone_id', 'app_id'])
    expect(paths['/zones/{zone_id}/access/apps/{app_id}'].get).toMatchObject({
      summary: 'Get an Access application',
      tags: ['access']
    })
  })

  it('keeps a concrete path the spec also lists on its own', () => {
    const spec = structuredClone(merged) as typeof merged & {
      paths: Record<string, Record<string, { summary: string }>>
    }
    spec.paths['/zones/{zone_id}/access/apps/{app_id}'] = { get: { summary: 'Zone-only entry' } }

    const { paths } = processSpec(spec)

    expect(paths['/zones/{zone_id}/access/apps/{app_id}'].get).toMatchObject({
      summary: 'Zone-only entry'
    })
    expect(paths['/accounts/{account_id}/access/apps/{app_id}'].get).toMatchObject({
      summary: 'Get an Access application'
    })
  })

  it('counts products for both split paths', () => {
    expect(extractProducts(merged)).toEqual(['access'])
  })
})

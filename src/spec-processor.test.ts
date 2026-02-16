import { describe, it, expect } from 'vitest'
import { extractProduct, resolveRefs, processSpec, extractProducts } from './spec-processor'

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

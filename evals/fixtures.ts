import type { OperationInfo } from '../src/openapi'

/**
 * A small, deterministic slice of the Cloudflare OpenAPI spec covering a
 * handful of well-known products. Evals seed this instead of the real ~2,500
 * endpoint spec: it keeps `search` fast and its results predictable, without
 * relying on production spec content that changes daily.
 */
export const EVAL_SPEC_PATHS: Record<string, Record<string, OperationInfo>> = {
  '/accounts/{account_id}/workers/scripts': {
    get: {
      summary: 'List Workers scripts',
      tags: ['Workers'],
      parameters: [{ name: 'account_id', in: 'path', required: true }],
      responses: {}
    }
  },
  '/accounts/{account_id}/storage/kv/namespaces': {
    get: {
      summary: 'List KV namespaces',
      tags: ['Workers KV'],
      parameters: [{ name: 'account_id', in: 'path', required: true }],
      responses: {}
    },
    post: {
      summary: 'Create a KV namespace',
      tags: ['Workers KV'],
      parameters: [{ name: 'account_id', in: 'path', required: true }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { title: { type: 'string' } },
              required: ['title']
            }
          }
        }
      },
      responses: {}
    }
  },
  '/accounts/{account_id}/d1/database': {
    post: {
      summary: 'Create a D1 database',
      tags: ['D1'],
      parameters: [{ name: 'account_id', in: 'path', required: true }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { name: { type: 'string' } },
              required: ['name']
            }
          }
        }
      },
      responses: {}
    }
  },
  '/zones': {
    get: {
      summary: 'List zones',
      tags: ['DNS'],
      parameters: [{ name: 'account.id', in: 'query', required: false }],
      responses: {}
    }
  }
}

export const EVAL_PRODUCTS = ['workers', 'workers kv', 'd1', 'dns']

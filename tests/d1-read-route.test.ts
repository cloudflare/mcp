import { describe, expect, it } from 'vitest'
import { D1_READ_QUERY_PATH, withD1ReadQueryOperation } from '../src/tools/d1-read-route'

const QUERY_PATH = '/accounts/{account_id}/d1/database/{database_id}/query'

describe('withD1ReadQueryOperation', () => {
  const paths = {
    [QUERY_PATH]: {
      post: {
        summary: 'Query D1 Database',
        tags: ['D1'],
        parameters: [{ name: 'account_id', in: 'path', required: true }],
        requestBody: { required: true, content: { 'application/json': {} } }
      }
    }
  }

  it('adds a searchable read-only copy of the query endpoint', () => {
    const operation = withD1ReadQueryOperation(paths)[D1_READ_QUERY_PATH]?.post as Record<
      string,
      unknown
    >

    expect(operation).toMatchObject({
      summary: 'Query D1 Database (read-only)',
      tags: ['D1'],
      requestBody: paths[QUERY_PATH].post.requestBody
    })
    expect(operation.description).toContain('not the Cloudflare API')
    expect(paths).not.toHaveProperty(D1_READ_QUERY_PATH)
  })

  it('leaves a spec without the query endpoint unchanged', () => {
    const other = { '/accounts': { get: { summary: 'List accounts' } } }
    expect(withD1ReadQueryOperation(other)).toBe(other)
  })
})

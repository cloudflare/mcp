import assert from 'node:assert/strict'
import { test } from 'node:test'
import { outputFor } from './output.ts'

const document = {
  openapi: '3.0.3',
  components: {
    schemas: {
      Namespace: {
        type: 'object',
        properties: {
          id: { type: 'string', readOnly: true },
          secret: { type: 'string', writeOnly: true }
        },
        required: ['id']
      }
    }
  }
}
const response = (schema: unknown) => ({
  responses: { '200': { content: { 'application/json': { schema } } } }
})

test('marks a schema that describes the unwrapped result and keeps it strict', () => {
  const output = outputFor(document, response({ $ref: '#/components/schemas/Namespace' }))!
  assert.equal(output.unwrapResult, true)
  const schema = output.schema as Record<string, any>
  const namespace = schema.$defs[schema.$ref.split('/').pop()]
  // readOnly fields are response fields; writeOnly ones are never returned.
  assert.deepEqual(Object.keys(namespace.properties), ['id'])
  assert.deepEqual(namespace.required, ['id'])
})

test('keeps the envelope when the schema documents result, at the root or in a root union', () => {
  const envelope = {
    type: 'object',
    properties: { result: { type: 'array' }, result_info: { type: 'object' } }
  }
  assert.equal(outputFor(document, response(envelope))!.unwrapResult, false)
  assert.equal(
    outputFor(document, response({ anyOf: [envelope, { type: 'object' }] }))!.unwrapResult,
    false
  )
})

test('translates OpenAPI 3.0 nullable and has no output without a JSON success body', () => {
  const output = outputFor(document, response({ type: 'string', nullable: true }))!
  assert.deepEqual((output.schema as Record<string, unknown>).anyOf, [
    { type: 'string' },
    { type: 'null' }
  ])
  assert.equal(
    outputFor(document, { responses: { '204': { description: 'No Content' } } }),
    undefined
  )
})

test('mcp-tools.json stores each distinct output schema once', async () => {
  const { packTools, unpackTools } = await import('../../src/mcp-tools.ts')
  type McpTool = import('../../src/mcp-tools.ts').McpTool
  const shared = { type: 'object', properties: { id: { type: 'string' } } }
  const tool = (name: string, outputSchema?: Record<string, unknown>): McpTool => ({
    name,
    description: name,
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {},
      required: []
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    permissions: {},
    request: {
      method: 'GET',
      path: `/${name}`,
      pathParams: [],
      queryParams: [],
      headerParams: [],
      cookieParams: []
    },
    ...(outputSchema ? { outputSchema } : {})
  })
  const artifact = packTools([
    tool('a', shared),
    tool('b', { ...shared }),
    tool('c'),
    tool('d', { type: 'array' })
  ])
  assert.equal(artifact.version, 2)
  assert.equal(artifact.outputSchemas.length, 2)
  assert.deepEqual(
    artifact.tools.map((entry) => entry.outputSchema),
    [0, 0, undefined, 1]
  )
  const [a, b, c] = unpackTools(JSON.parse(JSON.stringify(artifact)))
  assert.deepEqual(a!.outputSchema, shared)
  assert.equal(a!.outputSchema, b!.outputSchema)
  assert.equal(c!.outputSchema, undefined)
})

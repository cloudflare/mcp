import assert from 'node:assert/strict'
import { test } from 'node:test'
import Ajv from 'ajv/dist/2020.js'

function accepts(tool: { inputSchema: object }, input: unknown): boolean {
  const validate = new Ajv({ strict: false, validateFormats: false }).compile(tool.inputSchema)
  return validate(input)
}
import type { ForgeOpenApiDocument } from '@cloudflare/forge'
import { generateMcpTools } from './mcp.ts'

async function generate(
  overrides: Record<string, unknown> = {},
  schemas: NonNullable<ForgeOpenApiDocument['components']>['schemas'] = {}
) {
  const endpoint = {
    operationId: 'create',
    summary: 'Create widgets',
    responses: {},
    'x-fern-sdk-group-name': 'widgets',
    'x-fern-sdk-method-name': 'create',
    ...overrides
  }
  const source: ForgeOpenApiDocument = {
    openapi: '3.0.3',
    info: { title: 'Test', version: '1' },
    components: { schemas },
    paths: { '/widgets': { post: endpoint } }
  }
  const [file] = await generateMcpTools(source)
  assert.ok(file)
  return JSON.parse(file.content).tools[0]
}

test('keeps nested bodies, unions, constraints and required fields rather than CLI flattening', async () => {
  const body = {
    type: 'object',
    required: ['name', 'origin'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[a-z]+$' },
      origin: {
        type: 'object',
        required: ['host', 'port'],
        properties: {
          host: { type: 'string' },
          port: { type: 'integer', minimum: 1, maximum: 65535 }
        }
      },
      enabled: { type: 'boolean', default: true },
      labels: { type: 'array', maxItems: 10, items: { type: 'string', enum: ['a', 'b'] } },
      mode: { oneOf: [{ const: 'auto' }, { type: 'integer', minimum: 0 }] }
    }
  }
  const tool = await generate({
    requestBody: { required: true, content: { 'application/json': { schema: body } } }
  })
  assert.deepEqual(tool.inputSchema.properties.body, body)
  assert.deepEqual(tool.inputSchema.required, ['body'])
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['body'])
  assert.equal(
    accepts(tool, {
      body: { name: 'example', origin: { host: 'db.example.com', port: 5432 }, enabled: true }
    }),
    true
  )
  assert.equal(
    accepts(tool, { body: { name: 'example', origin: { host: 'db.example.com', port: '5432' } } }),
    false
  )
  assert.equal(accepts(tool, { body: { name: 'example', origin: { port: 5432 } } }), false)
  assert.equal(accepts(tool, { body: { name: 'example', origin: { host: 'x', port: 0 } } }), false)
  assert.equal(
    accepts(tool, {
      body: { name: 'example', origin: { host: 'x', port: 1 }, labels: ['invalid'] }
    }),
    false
  )
})

test('keeps typed query schemas and serialization rules', async () => {
  const tool = await generate({
    parameters: [
      { name: 'count', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
      { name: 'enabled', in: 'query', schema: { type: 'boolean' } },
      {
        name: 'labels',
        in: 'query',
        style: 'pipeDelimited',
        explode: false,
        schema: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } }
      },
      {
        name: 'filter',
        in: 'query',
        style: 'deepObject',
        explode: true,
        schema: { type: 'object', properties: { name: { type: 'string' } } }
      }
    ]
  })
  assert.equal(tool.inputSchema.properties.count.type, 'integer')
  assert.equal(tool.inputSchema.properties.count.maximum, 100)
  assert.equal(tool.inputSchema.properties.enabled.type, 'boolean')
  assert.deepEqual(tool.inputSchema.properties.labels.items.enum, ['a', 'b'])
  assert.deepEqual(tool.request.queryParams[2], {
    name: 'labels',
    key: 'labels',
    style: 'pipeDelimited',
    explode: false,
    allowReserved: false
  })
  assert.equal(tool.request.queryParams[3].style, 'deepObject')
})

test('copies only reachable refs into local defs and preserves recursion', async () => {
  const tool = await generate(
    {
      requestBody: {
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } }
      }
    },
    {
      Node: {
        type: 'object',
        properties: { children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } }
      },
      Unused: { type: 'string' }
    }
  )
  assert.deepEqual(tool.inputSchema.properties.body, { $ref: '#/$defs/schema0' })
  assert.deepEqual(tool.inputSchema.$defs, {
    schema0: {
      type: 'object',
      properties: { children: { type: 'array', items: { $ref: '#/$defs/schema0' } } }
    }
  })
})

test('normalizes OpenAPI 3.0 nullable and exclusive bounds to JSON Schema', async () => {
  const tool = await generate({
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'number',
            nullable: true,
            minimum: 1,
            exclusiveMinimum: true,
            maximum: 5,
            exclusiveMaximum: false
          }
        }
      }
    }
  })
  assert.deepEqual(tool.inputSchema.properties.body, {
    anyOf: [{ type: 'number', exclusiveMinimum: 1, maximum: 5 }, { type: 'null' }]
  })
})

test('applies Forge parameter descriptions, enum and default overrides to referenced schemas', async () => {
  const tool = await generate(
    {
      parameters: [{ name: 'mode', in: 'query', schema: { $ref: '#/components/schemas/Mode' } }],
      'x-forge-params': {
        mode: {
          choices: ['safe', 'fast'],
          default: null,
          description: 'Execution mode',
          required: true
        }
      }
    },
    { Mode: { type: 'string', enum: ['safe'], default: 'safe', description: 'Original' } }
  )
  assert.deepEqual(tool.inputSchema.properties.mode, {
    type: 'string',
    enum: ['safe', 'fast'],
    description: 'Execution mode'
  })
  assert.deepEqual(tool.inputSchema.required, ['mode'])
})

test('defaults to JSON but retains alternative content types with their own body schemas', async () => {
  const tool = await generate({
    requestBody: {
      content: {
        'text/plain': { schema: { type: 'string' } },
        'application/json': { schema: { type: 'array', items: { type: 'integer' } } }
      }
    }
  })
  assert.equal(tool.request.body.contentType, 'application/json')
  assert.deepEqual(tool.inputSchema.required, [])
  assert.equal(accepts(tool, { body: [1, 2] }), true)
  assert.equal(accepts(tool, { body: 'raw text' }), false)
  assert.equal(accepts(tool, { body: 'raw text', content_type: 'text/plain' }), true)
  assert.equal(accepts(tool, { body: [1], content_type: 'text/plain' }), false)
  assert.equal(accepts(tool, { body: [1], content_type: 'application/xml' }), false)
})

test('preserves multipart field schemas and encoding without requiring a JSON alternative', async () => {
  const tool = await generate({
    requestBody: {
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: { metadata: { type: 'object' }, file: { type: 'string', format: 'binary' } }
          },
          encoding: { metadata: { contentType: 'application/json' } }
        }
      }
    }
  })
  assert.equal(tool.inputSchema.properties.body.properties.file.format, 'binary')
  assert.deepEqual(tool.request.body, {
    contentType: 'multipart/form-data',
    content: {
      'multipart/form-data': { encoding: { metadata: { contentType: 'application/json' } } }
    }
  })
})

test('does not rewrite refs in example JSON payloads', async () => {
  const tool = await generate({
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            examples: [{ $ref: 'https://example.com/payload-not-a-schema' }]
          }
        }
      }
    }
  })
  assert.deepEqual(tool.inputSchema.properties.body.examples, [
    { $ref: 'https://example.com/payload-not-a-schema' }
  ])
})

test('removes ignored and read-only input fields, including referenced fields, from required lists', async () => {
  const ignoredField = { type: 'string' as const, 'x-fern-ignore': true }
  const tool = await generate(
    {
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['visible', 'ignored', 'id'],
              properties: {
                visible: { type: 'boolean' },
                ignored: { $ref: '#/components/schemas/Ignored' },
                id: { type: 'string', readOnly: true }
              }
            }
          }
        }
      }
    },
    { Ignored: ignoredField }
  )
  assert.deepEqual(Object.keys(tool.inputSchema.properties.body.properties), ['visible'])
  assert.deepEqual(tool.inputSchema.properties.body.required, ['visible'])
  assert.equal(accepts(tool, { body: { visible: true } }), true)
})

test('applies the CLI generator parameter knobs to nested body fields without flattening', async () => {
  const tool = await generate(
    {
      'x-forge-params': {
        'origin.port': { required: true, default: null, description: 'Database port' },
        'origin.mode': { choices: ['safe', 'fast'] },
        'origin.secret': { hidden: true },
        labels: { array: true, choices: ['a', 'b'] }
      },
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                origin: { $ref: '#/components/schemas/Origin' },
                labels: { type: 'string' }
              }
            }
          }
        }
      }
    },
    {
      Origin: {
        type: 'object',
        required: ['secret'],
        properties: {
          port: { type: 'integer', default: 5432 },
          mode: { type: 'string', enum: ['safe'] },
          secret: { type: 'string' }
        }
      }
    }
  )
  const origin = tool.inputSchema.$defs.schema0
  assert.equal(origin.properties.port.default, undefined)
  assert.equal(origin.properties.port.description, 'Database port')
  assert.equal(origin.properties.secret, undefined)
  assert.deepEqual(origin.required, ['port'])
  assert.equal(
    accepts(tool, { body: { origin: { port: 123, mode: 'fast' }, labels: ['a', 'b'] } }),
    true
  )
  assert.equal(accepts(tool, { body: { origin: { mode: 'safe' } } }), false)
  assert.equal(accepts(tool, { body: { labels: 'a' } }), false)
})

test('ignores parameters and hidden overrides by default', async () => {
  const tool = await generate({
    parameters: [
      { name: 'visible', in: 'query', schema: { type: 'string' } },
      { name: 'ignored', in: 'query', 'x-fern-ignore': true, schema: { type: 'string' } },
      { name: 'hidden', in: 'query', schema: { type: 'string' } }
    ],
    'x-forge-params': { hidden: { hidden: true } }
  })
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ['visible'])
  assert.equal(tool.request.queryParams.length, 1)
})

test('fails generation for unbundled or dangling schema refs', async () => {
  for (const ref of ['https://example.com/schema.json', '#/components/schemas/Missing']) {
    await assert.rejects(
      generate({ requestBody: { content: { 'application/json': { schema: { $ref: ref } } } } }),
      /reference/
    )
  }
})

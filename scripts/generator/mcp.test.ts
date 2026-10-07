import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { initFromOpenApi, type ForgeOpenApiDocument } from '@cloudflare/forge'
import { ACCOUNT_ID_DESCRIPTION } from '../../src/mcp-tools.ts'
import { generateMcpTools } from './mcp.ts'

function operation(overrides: Record<string, unknown> = {}) {
  return {
    operationId: 'list-widgets',
    summary: 'List widgets',
    description: 'Find widgets by name.',
    responses: { '200': { description: 'OK' } },
    'x-fern-sdk-group-name': ['widgets'],
    'x-fern-sdk-method-name': 'list',
    'x-fern-availability': 'generally-available',
    ...overrides
  }
}

function document(paths: ForgeOpenApiDocument['paths']): ForgeOpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Widgets', version: '1' },
    paths,
    components: { schemas: {} }
  }
}

async function generate(source: ForgeOpenApiDocument) {
  const files = await generateMcpTools(source)
  assert.equal(files.length, 1)
  const file = files[0]
  assert.ok(file)
  assert.equal(file.path, 'mcp-tools.json')
  return JSON.parse(file.content)
}

test('emits one self-contained artifact through the Forge lifecycle', async () => {
  const source = document({ '/accounts/{account_id}/widgets': { get: operation() } })
  const forge = initFromOpenApi(source)
  const directory = await mkdtemp(join(tmpdir(), 'forge-mcp-'))
  try {
    await forge.finalize(directory, await generateMcpTools(source))
    const artifact = JSON.parse(await readFile(join(directory, 'mcp-tools.json'), 'utf8'))
    assert.equal(artifact.version, 2)
    assert.deepEqual(artifact.outputSchemas, [])
    assert.deepEqual(artifact.tools, [
      {
        name: 'widgets_list',
        title: 'List widgets',
        description: 'GET /accounts/{account_id}/widgets\n\nList widgets\n\nFind widgets by name.',
        inputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { account_id: { type: 'string', description: ACCOUNT_ID_DESCRIPTION } },
          required: []
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
        operationId: 'list-widgets',
        status: 'generally-available',
        permissions: {},
        request: {
          method: 'GET',
          path: '/accounts/{account_id}/widgets',
          pathParams: [
            {
              name: 'account_id',
              key: 'account_id',
              style: 'simple',
              explode: false,
              allowReserved: false
            }
          ],
          queryParams: [],
          headerParams: [],
          cookieParams: []
        }
      }
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('makes account_id optional with one caller-independent description', async () => {
  const artifact = await generate(
    document({
      '/accounts/{account_id}/widgets/{widget_id}': {
        get: operation({
          parameters: [
            {
              name: 'account_id',
              in: 'path',
              required: true,
              schema: { type: 'string', maxLength: 32 }
            },
            { name: 'widget_id', in: 'path', required: true, schema: { type: 'string' } }
          ]
        })
      },
      '/zones/{zone_id}/widgets': {
        get: operation({ operationId: 'zone-widgets', 'x-fern-sdk-method-name': 'zone' })
      }
    })
  )
  const [account, zone] = artifact.tools
  assert.deepEqual(account.inputSchema.properties.account_id, {
    type: 'string',
    description: ACCOUNT_ID_DESCRIPTION
  })
  assert.deepEqual(account.inputSchema.required, ['widget_id'])
  // The route still fills account_id into the path.
  assert.deepEqual(
    account.request.pathParams.map(({ name }: { name: string }) => name),
    ['account_id', 'widget_id']
  )
  assert.deepEqual(zone.inputSchema.required, ['zone_id'])
})

test('keeps every non-deprecated operation an OAuth connection can call, whatever its audience or visibility', async () => {
  const paths: ForgeOpenApiDocument['paths'] = {}
  for (const [name, flags] of Object.entries({
    hidden: { 'x-forge-hidden': true },
    hiddenNoSuccess: { 'x-forge-hidden': true, responses: { '4XX': { description: 'Error' } } },
    deprecated: { 'x-fern-availability': 'deprecated' },
    ignored: { 'x-fern-ignore': true },
    sdkOnly: { 'x-fern-audiences': ['sdk'] },
    terraformOnly: { 'x-fern-audiences': 'terraform' },
    cli: { 'x-fern-audiences': ['sdk', 'cf-cli'] },
    mcp: { 'x-fern-audiences': ['sdk', 'mcp'] },
    mcpString: { 'x-fern-audiences': 'mcp' },
    specialToken: { security: [{ pages_upload_token: [] }] },
    noOAuthScope: { 'x-api-token-group': ['Billing Read'] },
    aliasedScope: { 'x-api-token-group': ['Browser Rendering Read'] }
  })) {
    paths[`/${name}`] = {
      get: operation({ operationId: name, 'x-fern-sdk-method-name': name, ...flags })
    }
  }
  const artifact = await generate(document(paths))
  assert.deepEqual(
    artifact.tools.map((tool: { name: string }) => tool.name),
    [
      'widgets_aliasedScope',
      'widgets_cli',
      'widgets_hidden',
      'widgets_hiddenNoSuccess',
      'widgets_ignored',
      'widgets_mcp',
      'widgets_mcpString',
      'widgets_sdkOnly',
      'widgets_terraformOnly'
    ]
  )
  // The tool records the permission under the name its OAuth scope uses, so
  // refusal explanations and scope challenges can find the scope.
  const aliased = artifact.tools.find(
    (tool: { name: string }) => tool.name === 'widgets_aliasedScope'
  )
  assert.deepEqual(aliased.permissions, { 'x-api-token-group': ['Browser Run Read'] })
})

test('uses Forge aliases and normalized method names, without inventing names for ungrouped operations', async () => {
  const artifact = await generate(
    document({
      '/one': { get: operation({ operationId: 'one' }) },
      '/two': { get: operation({ operationId: 'two' }) },
      '/alias': {
        get: operation({
          operationId: 'alias',
          'x-forge-aliases': [
            { 'x-fern-sdk-group-name': 'widgets.nested', 'x-fern-sdk-method-name': 'read' },
            { 'x-fern-sdk-group-name': ['other', 'nested'], 'x-fern-sdk-method-name': 'read' }
          ]
        })
      },
      '/ungrouped': { get: { operationId: 'ungrouped', summary: 'No group', responses: {} } }
    })
  )
  assert.deepEqual(
    artifact.tools.map((tool: { name: string }) => tool.name),
    ['other_nested_read', 'widgets_nested_read', 'widgets_one', 'widgets_two']
  )
})

test('an ignored alias does not name a tool; the operation keeps its own Forge name', async () => {
  const { tools } = await generate(
    document({
      '/ignored': {
        get: operation({
          'x-forge-aliases': [
            {
              'x-fern-sdk-group-name': 'widgets',
              'x-fern-sdk-method-name': 'ignored',
              'x-fern-ignore': true
            }
          ]
        })
      }
    })
  )
  assert.deepEqual(
    tools.map((tool: { name: string }) => tool.name),
    ['widgets_list']
  )
})

test('keeps named operations without operationIds and supports HEAD and OPTIONS', async () => {
  const source = document({
    '/head': { head: operation({ operationId: 'head', 'x-fern-sdk-method-name': 'head' }) },
    '/options': {
      options: operation({ operationId: 'options', 'x-fern-sdk-method-name': 'options' })
    },
    '/no-id': { get: operation({ operationId: undefined, 'x-fern-sdk-method-name': 'no_id' }) }
  })
  const { tools } = await generate(source)
  assert.equal(tools.length, 3)
  assert.equal(tools[0].request.method, 'HEAD')
  assert.equal(tools[0].annotations.readOnlyHint, true)
  assert.equal(tools[1].operationId, undefined)
  assert.equal(tools[2].request.method, 'OPTIONS')
})

test('resolves refs, path-level parameters, overrides, headers and typed bodies', async () => {
  const source = document({
    '/widgets/{id}': {
      parameters: [{ $ref: '#/components/parameters/id~1parameter' }],
      put: operation({
        'x-fern-sdk-method-name': 'update',
        'x-forge-params': {
          id: { description: 'Widget identifier' },
          verbose: { required: true, description: 'Include details' }
        },
        'x-api-token-group': ['DNS Write'],
        'x-cfPermissionsRequired': { enum: ['widgets:write'] },
        parameters: [
          { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
          {
            name: 'If-Match',
            in: 'header',
            required: true,
            description: 'ETag',
            schema: { type: 'string' }
          }
        ],
        requestBody: { $ref: '#/components/requestBodies/payload' }
      })
    }
  })
  source.components = {
    schemas: {},
    parameters: {
      'id/parameter': { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
    },
    requestBodies: {
      payload: {
        required: true,
        description: 'Widget payload',
        content: { 'application/json': { schema: { type: 'object' } } }
      }
    }
  }
  const {
    tools: [tool]
  } = await generate(source)
  assert.deepEqual(tool.inputSchema.properties.id, {
    type: 'string',
    description: 'Widget identifier'
  })
  assert.deepEqual(tool.inputSchema.properties.verbose, {
    type: 'boolean',
    description: 'Include details'
  })
  assert.deepEqual(tool.inputSchema.required, ['id', 'verbose', 'header_if_match', 'body'])
  assert.deepEqual(tool.request.headerParams, [
    {
      name: 'If-Match',
      key: 'header_if_match',
      style: 'simple',
      explode: false,
      allowReserved: false
    }
  ])
  assert.deepEqual(tool.request.body, {
    contentType: 'application/json',
    content: { 'application/json': { encoding: {} } }
  })
  assert.deepEqual(tool.inputSchema.properties.body, {
    type: 'object',
    description: 'Widget payload'
  })
  assert.deepEqual(tool.permissions, {
    'x-api-token-group': ['DNS Write'],
    'x-cfPermissionsRequired': { enum: ['widgets:write'] }
  })
  assert.equal(tool.annotations.destructiveHint, true)
})

test('operation parameters override path-level parameters; argument collisions do not lose routing', async () => {
  const source = document({
    '/widgets/{id}/{body}': {
      parameters: [
        { name: 'id', in: 'path', required: true, description: 'old', schema: { type: 'string' } }
      ],
      post: operation({
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'new',
            schema: { type: 'string' }
          },
          { name: 'id', in: 'query', schema: { type: 'string' } },
          { name: '__proto__', in: 'query', schema: { type: 'string' } }
        ],
        requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } }
      })
    }
  })
  const {
    tools: [tool]
  } = await generate(source)
  assert.equal(tool.inputSchema.properties.id.description, 'new')
  assert.deepEqual(tool.request.pathParams, [
    { name: 'id', key: 'id', style: 'simple', explode: false, allowReserved: false },
    { name: 'body', key: 'path_body', style: 'simple', explode: false, allowReserved: false }
  ])
  assert.deepEqual(tool.request.queryParams, [
    { name: 'id', key: 'query_id', style: 'form', explode: true, allowReserved: false },
    { name: '__proto__', key: '__proto__', style: 'form', explode: true, allowReserved: false }
  ])
  assert.equal(tool.inputSchema.properties.__proto__.type, 'string')
  assert.equal(tool.inputSchema.properties.body.type, 'string')
})

test('confirmation metadata overrides read-only hints and is visible in the description', async () => {
  const {
    tools: [tool]
  } = await generate(
    document({
      '/danger': {
        get: operation({ 'x-forge-require-confirmation': 'This operation removes all widgets.' })
      }
    })
  )
  assert.equal(tool.annotations.readOnlyHint, false)
  assert.equal(tool.annotations.destructiveHint, true)
  assert.match(tool.description, /This operation removes all widgets\./)
})

test('tool names are bounded, collision-safe and independent of path order', async () => {
  const paths: ForgeOpenApiDocument['paths'] = {
    '/one': { get: operation({ operationId: 'one', 'x-fern-sdk-group-name': ['a-b'] }) },
    '/two': { get: operation({ operationId: 'two', 'x-fern-sdk-group-name': ['a_b'] }) },
    '/long': { get: operation({ operationId: 'long', 'x-fern-sdk-group-name': ['a'.repeat(140)] }) }
  }
  const first = await generate(document(paths))
  const second = await generate(document(Object.fromEntries(Object.entries(paths).reverse())))
  assert.deepEqual(first, second)
  const names = first.tools.map((tool: { name: string }) => tool.name)
  assert.equal(new Set(names).size, 3)
  for (const name of names) assert.match(name, /^[a-zA-Z0-9_]{1,128}$/)
})

test('uses the supplied document even after another Forge instance is initialized', async () => {
  const source = document({ '/first': { get: operation() } })
  initFromOpenApi(document({ '/second': { get: operation() } }))
  const [file] = await generateMcpTools(source)
  assert.ok(file)
  assert.equal(JSON.parse(file.content).tools[0].request.path, '/first')
})

test('preserves cookie parameter routing', async () => {
  const {
    tools: [tool]
  } = await generate(
    document({
      '/cookie': {
        get: operation({
          parameters: [{ name: 'session', in: 'cookie', schema: { type: 'string' } }]
        })
      }
    })
  )
  assert.deepEqual(tool.request.cookieParams, [
    { name: 'session', key: 'session', style: 'form', explode: true, allowReserved: false }
  ])
})

test('keeps a group named like a sibling method, which the cf CLI drops, under its Forge name', async () => {
  const artifact = await generate(
    document({
      '/quota': { get: operation({ operationId: 'quota', 'x-fern-sdk-method-name': 'quota' }) },
      '/quota/v2': {
        get: operation({
          operationId: 'quota-v2',
          'x-fern-sdk-group-name': ['widgets', 'quota'],
          'x-fern-sdk-method-name': 'get'
        })
      },
      '/other': {
        get: operation({
          operationId: 'other',
          'x-fern-sdk-group-name': ['widgets', 'other'],
          'x-fern-sdk-method-name': 'get'
        })
      }
    })
  )
  assert.deepEqual(
    artifact.tools.map((tool: { name: string }) => tool.name),
    ['widgets_other_get', 'widgets_quota', 'widgets_quota_get']
  )
})

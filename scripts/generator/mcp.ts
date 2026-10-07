import { createHash } from 'node:crypto'
import {
  initFromOpenApi,
  isMethodGroup,
  type ForgeOpenApiDocument,
  type Schema
} from '@cloudflare/forge'
import {
  applyOverride,
  ignored,
  record,
  resolve,
  schemaCompiler,
  type JsonSchema
} from './json-schema.ts'
import {
  ACCOUNT_ID_DESCRIPTION,
  packTools,
  type McpTool,
  type McpToolsArtifact,
  type ParameterRoute
} from '../../src/mcp-tools.ts'
import { outputFor } from './output.ts'
import { oauthReach } from './oauth.ts'
import { permissionLabels } from './spec.ts'

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const

type Method = { group: string[]; method: Schema.method }
type Candidate = { tool: McpTool; identity: string; inTree: boolean }

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

// Prefer JSON when a caller doesn't select a content type.
function mediaType(content: Record<string, unknown>): string | undefined {
  const types = Object.keys(content).sort()
  return (
    types.find((type) => type === 'application/json') ??
    types.find((type) => type.endsWith('+json')) ??
    types[0]
  )
}

/**
 * Walk Forge's command tree the way the cf CLI generator does: deprecated
 * methods are skipped, and a group named like a sibling method is dropped,
 * because a CLI command cannot be both a leaf and a group.
 */
function* commandTree(
  items: Array<Schema.method | Schema.methodGroup>,
  group: string[]
): Generator<Method> {
  const leaves = new Set(
    items
      .filter((item) => !isMethodGroup(item) && item.status !== 'deprecated')
      .map((item) => item.name)
  )
  for (const item of items) {
    if (!isMethodGroup(item)) {
      if (item.status !== 'deprecated') yield { group, method: item }
    } else if (!leaves.has(item.name)) {
      yield* commandTree(item.methods, [...group, item.name])
    }
  }
}

function buildTool(
  document: unknown,
  path: string,
  verb: string,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
  group: string[],
  method: Record<string, unknown>
): McpTool {
  const name = [...group, text(method.name) ?? 'operation'].join('_').replace(/[^a-zA-Z0-9_]/g, '_')
  const summary = text(operation.summary)
  const description = [
    ...new Set([summary, text(operation.description)].filter((value) => value))
  ].join('\n\n')
  const confirmation = text(method.requireConfirmation)
  const readOnlyHint = !confirmation && ['get', 'head', 'options'].includes(verb)
  const tool: McpTool = {
    name,
    ...(summary ? { title: summary } : {}),
    description: [`${verb.toUpperCase()} ${path}`, description, confirmation]
      .filter(Boolean)
      .join('\n\n'),
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {},
      required: []
    },
    // Non-read operations stay conservatively destructive, as MCP recommends.
    // Confirmation metadata also overrides a nominally read-only HTTP method.
    annotations: { readOnlyHint, destructiveHint: !readOnlyHint, openWorldHint: true },
    permissions: {},
    request: {
      method: verb.toUpperCase(),
      path,
      pathParams: [],
      queryParams: [],
      headerParams: [],
      cookieParams: []
    }
  }
  const operationId = text(operation.operationId)
  if (operationId) tool.operationId = operationId
  const status = text(method.status) ?? text(operation['x-fern-availability'])
  if (status) tool.status = status
  const tokenGroup = permissionLabels(operation['x-api-token-group'])
  if (tokenGroup) tool.permissions['x-api-token-group'] = tokenGroup
  if (operation['x-cfPermissionsRequired'] !== undefined) {
    tool.permissions['x-cfPermissionsRequired'] = operation['x-cfPermissionsRequired']
  }

  const parameters = new Map<string, Record<string, unknown>>()
  for (const owner of [pathItem, operation]) {
    if (!Array.isArray(owner.parameters)) continue
    for (const value of owner.parameters) {
      const parameter = resolve(value, document)
      const parameterName = text(parameter.name)
      const location = text(parameter.in)
      if (parameterName && location) parameters.set(`${location}:${parameterName}`, parameter)
    }
  }
  // Infer template parameters even when upstream omitted their declarations.
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    const parameterName = match[1]
    if (parameterName && !parameters.has(`path:${parameterName}`)) {
      parameters.set(`path:${parameterName}`, { name: parameterName, in: 'path', required: true })
    }
  }

  const body =
    operation.requestBody === undefined || ignored(operation.requestBody, document)
      ? undefined
      : resolve(operation.requestBody, document)
  const used = new Set(body ? ['body', 'content_type'] : [])
  const compiler = schemaCompiler(document)
  const properties = new Map<string, JsonSchema>()
  const overrides = record(method.params)
  for (const parameter of parameters.values()) {
    const parameterName = text(parameter.name)
    const location = text(parameter.in)
    if (!parameterName || !location) continue
    if (!['path', 'query', 'header', 'cookie'].includes(location)) {
      throw new Error(
        `Unsupported MCP parameter location ${location} on ${verb.toUpperCase()} ${path}`
      )
    }
    const override = record(overrides[parameterName])
    if (
      ignored(parameter, document) ||
      ignored(parameter.schema, document) ||
      override.hidden === true
    )
      continue
    const base =
      location === 'header'
        ? `header_${parameterName.toLowerCase().replaceAll('-', '_')}`
        : parameterName
    let key = base
    while (used.has(key)) key = `${location}_${key}`
    used.add(key)
    const content = record(parameter.content)
    const contentType = mediaType(content)
    const source = parameter.schema ??
      (contentType ? record(content[contentType]).schema : undefined) ?? { type: 'string' }
    const schema = resolve(source, document)
    const converted = compiler.convert(source)
    // Overrides must replace referenced constraints, not intersect with them.
    const property = {
      ...record(Object.keys(override).length ? compiler.convert(schema) : converted)
    }
    property.description =
      text(parameter.description) ??
      text(schema.description) ??
      `${location} parameter: ${parameterName}`
    properties.set(key, converted === false ? false : applyOverride(property, override))
    if (location === 'path' || (override.required ?? parameter.required) === true)
      tool.inputSchema.required.push(key)
    const style =
      text(parameter.style) ?? (location === 'query' || location === 'cookie' ? 'form' : 'simple')
    const route: ParameterRoute = {
      name: parameterName,
      key,
      style,
      explode: typeof parameter.explode === 'boolean' ? parameter.explode : style === 'form',
      allowReserved: parameter.allowReserved === true,
      ...(contentType ? { contentType } : {})
    }
    if (location === 'path') tool.request.pathParams.push(route)
    else if (location === 'query') tool.request.queryParams.push(route)
    else if (location === 'header') tool.request.headerParams.push(route)
    else tool.request.cookieParams.push(route)
  }
  if (body) {
    const content = Object.fromEntries(
      Object.entries(record(body.content)).filter(
        ([, media]) => !ignored(record(media).schema, document)
      )
    )
    const contentType = mediaType(content)
    if (contentType) {
      const variants = Object.entries(content).map(([type, value]) => {
        const media = record(value)
        const schema = compiler.convert(media.schema, overrides)
        return { type, schema, encoding: record(media.encoding) }
      })
      const schemas = variants.map(({ schema }) => schema)
      const schema = schemas.length === 1 ? schemas[0] : { anyOf: schemas }
      properties.set(
        'body',
        typeof body.description === 'string' && schema !== false
          ? { ...record(schema), description: body.description }
          : (schema ?? {})
      )
      if (body.required === true) tool.inputSchema.required.push('body')
      tool.request.body = {
        contentType,
        content: Object.fromEntries(variants.map(({ type, encoding }) => [type, { encoding }]))
      }
      if (variants.length > 1) {
        properties.set('content_type', {
          type: 'string',
          enum: variants.map(({ type }) => type),
          default: contentType
        })
        // Missing content_type means the documented default, not any body shape.
        tool.inputSchema.allOf = variants.map(({ type, schema }) => ({
          if: {
            properties: { content_type: { const: type } },
            ...(type === contentType ? {} : { required: ['content_type'] })
          },
          // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema conditional keyword, not a promise.
          then: { properties: { body: schema } }
        }))
      }
    }
  }
  // account_id is never required: the server fills in the session's account when
  // it can. The schema can't depend on the caller, because clients cache tool
  // metadata and may share it across users.
  const accountId = tool.request.pathParams.find(({ name }) => name === 'account_id')
  if (accountId) {
    properties.set(accountId.key, { type: 'string', description: ACCOUNT_ID_DESCRIPTION })
    tool.inputSchema.required = tool.inputSchema.required.filter((key) => key !== accountId.key)
  }
  tool.inputSchema.properties = Object.fromEntries(properties)
  const definitions = compiler.definitions()
  if (Object.keys(definitions).length) tool.inputSchema.$defs = definitions
  const output = outputFor(document, operation)
  if (output) {
    tool.outputSchema = output.schema
    if (output.unwrapResult) tool.request.unwrapResult = true
  }
  return tool
}

/** Literal path segments, without parameters. */
function literals(path: string): string[] {
  return path.split('/').filter((segment) => segment && !segment.startsWith('{'))
}

/**
 * Give every tool a unique name. Forge sometimes names two operations alike,
 * typically a deprecated path and its replacement. The operation in Forge's
 * command tree (the cf command) keeps the name; the others gain the path
 * segments that set them apart, or are named after their own path, then the
 * HTTP method, and a hash only as a last resort.
 */
function disambiguate(candidates: Candidate[]): McpTool[] {
  const groups = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    groups.set(candidate.tool.name, [...(groups.get(candidate.tool.name) ?? []), candidate])
  }
  const taken = new Set<string>()
  const result: McpTool[] = []
  const claim = (tool: McpTool, name: string) => {
    tool.name = name
    taken.add(name)
    result.push(tool)
  }
  const fits = (name: string) => name.length <= 128 && !taken.has(name) && !groups.has(name)
  for (const [name, group] of groups) {
    const ordered = [...group].sort((a, b) => Number(b.inTree) - Number(a.inTree))
    const [first, ...rest] = ordered
    if (rest.length === 0 || !first!.inTree || ordered.filter((c) => c.inTree).length > 1) {
      // No single canonical owner: everyone is disambiguated below.
      if (rest.length === 0 && name.length <= 128) {
        claim(first!.tool, name)
        continue
      }
    } else {
      claim(first!.tool, name)
      ordered.shift()
    }
    for (const candidate of rest.length === 0 || !first!.inTree ? ordered : rest) {
      const base = literals(first!.tool.request.path)
      const distinct = literals(candidate.tool.request.path)
        .filter((segment) => !base.includes(segment))
        .map((segment) => segment.replace(/[^a-zA-Z0-9]+/g, '_'))
      const method = name.split('_').pop()!
      const fromPath = literals(candidate.tool.request.path)
        .filter((segment) => segment !== 'accounts' && segment !== 'zones')
        .map((segment) => segment.replace(/[^a-zA-Z0-9]+/g, '_'))
        .join('_')
      const options = [
        distinct.length ? `${name}_${distinct.join('_')}` : '',
        fromPath ? `${fromPath}_${method}` : '',
        `${name}_${candidate.tool.request.method.toLowerCase()}`,
        `${name.slice(0, 115)}_${createHash('sha256').update(candidate.identity).digest('hex').slice(0, 12)}`
      ]
      const chosen = options.find((option) => option && fits(option))
      if (!chosen) throw new Error(`Duplicate MCP tool name: ${name}`)
      claim(candidate.tool, chosen)
    }
  }
  return result
}

/**
 * Generate `mcp-tools.json` from a bundled Forge API document.
 * Includes every non-deprecated operation an OAuth connection can call (see
 * oauth.ts), including hidden, SDK-only and x-fern-ignore ones, so the direct tools
 * cover what Code Mode can do. Excludes deprecated operations (Code Mode still
 * reaches them), operations that need another security scheme, and operations
 * whose permissions have no OAuth scope. Names follow Forge's command tree (cf
 * command paths) and, outside it, the operation's Forge group and method.
 */
export async function generateMcpTools(source: ForgeOpenApiDocument) {
  const document = structuredClone(source)
  // The public Forge snapshot doesn't filter ignored aliases during init.
  // Filter before building its command tree so ignored aliases cannot affect naming.
  for (const item of Object.values(document.paths)) {
    const pathItem = record(item)
    for (const verb of HTTP_METHODS) {
      const operation = record(pathItem[verb])
      if (Array.isArray(operation['x-forge-aliases'])) {
        operation['x-forge-aliases'] = operation['x-forge-aliases'].filter(
          (alias) => record(alias)['x-fern-ignore'] !== true
        )
      }
    }
  }
  const forge = initFromOpenApi(document)
  const methods = new Map<string, Method[]>()
  for (const [command, schema] of forge.commands) {
    for (const entry of commandTree(schema.methods, [command])) {
      const variants = methods.get(entry.method.operationId) ?? []
      variants.push(entry)
      methods.set(entry.method.operationId, variants)
    }
  }
  const candidates: Candidate[] = []
  for (const [path, item] of Object.entries(document.paths)) {
    const pathItem = record(item)
    for (const verb of HTTP_METHODS) {
      const operation = record(pathItem[verb])
      if (!Object.keys(operation).length || !oauthReach(record(document), operation).reachable)
        continue
      const operationId = text(operation.operationId)
      const variants = operationId ? methods.get(operationId) : undefined
      const rawGroup = strings(operation['x-fern-sdk-group-name'])
        .flatMap((part) => part.split('.'))
        .filter(Boolean)
      const rawMethod = text(operation['x-fern-sdk-method-name'])
      // Forge's command tree leaves out deprecated and ignored operations and
      // ones without an operationId; name those from their Forge group and method.
      const entries =
        variants ??
        (rawGroup.length && rawMethod
          ? [
              {
                group: rawGroup,
                method: {
                  name: rawMethod,
                  status: operation['x-fern-availability'],
                  params: operation['x-forge-params'],
                  requireConfirmation: operation['x-forge-require-confirmation']
                }
              }
            ]
          : [])
      for (const { group, method } of entries) {
        // Deprecated operations duplicate their replacements' names and are still
        // reachable through Code Mode, so the direct tools leave them out.
        if ((text(method.status) ?? text(operation['x-fern-availability'])) === 'deprecated')
          continue
        const tool = buildTool(document, path, verb, pathItem, operation, group, record(method))
        const identity = JSON.stringify([verb, path, group, method.name])
        candidates.push({ tool, identity, inTree: variants !== undefined })
      }
    }
  }
  const tools = disambiguate(candidates).sort((a, b) => a.name.localeCompare(b.name))
  return forge.transform(async (output) => {
    const artifact: McpToolsArtifact = packTools(tools)
    output.emit('mcp-tools.json', JSON.stringify(artifact))
  })
}

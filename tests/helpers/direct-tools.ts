import { ACCOUNT_ID_DESCRIPTION, type McpTool, type ParameterRoute } from '../../src/mcp-tools'

/**
 * Build an `mcp-tools.json` entry the way the generator shapes it, for tests
 * that exercise serving and dispatch. Path parameters come from the template;
 * `account_id` is optional like every generated account-scoped tool.
 */
export function directTool({
  name,
  method = 'GET',
  path,
  query = [],
  requiredQuery = [],
  headers = [],
  body,
  title,
  permissions
}: {
  name: string
  method?: string
  path: string
  query?: string[]
  requiredQuery?: string[]
  headers?: string[]
  body?: string | string[]
  title?: string
  /** `x-api-token-group`: the API token permissions the endpoint accepts. */
  permissions?: string[]
}): McpTool {
  const route = (name: string, key = name, style = 'simple'): ParameterRoute => ({
    name,
    key,
    style,
    explode: style === 'form',
    allowReserved: false
  })
  const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => route(match[1]!))
  const queryParams = [...query, ...requiredQuery].map((name) => route(name, name, 'form'))
  const headerParams = headers.map((name) =>
    route(name, `header_${name.toLowerCase().replaceAll('-', '_')}`)
  )
  const properties: McpTool['inputSchema']['properties'] = {}
  const required: string[] = []
  for (const param of pathParams) {
    if (param.name === 'account_id') {
      properties[param.key] = { type: 'string', description: ACCOUNT_ID_DESCRIPTION }
    } else {
      properties[param.key] = { type: 'string', description: `path parameter: ${param.name}` }
      required.push(param.key)
    }
  }
  for (const param of [...queryParams, ...headerParams]) {
    properties[param.key] = { type: 'string', description: param.name }
  }
  required.push(...requiredQuery)

  const contentTypes = typeof body === 'string' ? [body] : (body ?? [])
  if (contentTypes.length) {
    properties['body'] = { type: 'object' }
    if (contentTypes.length > 1) {
      properties['content_type'] = { type: 'string', enum: contentTypes, default: contentTypes[0] }
    }
  }

  const readOnlyHint = method === 'GET'
  return {
    name,
    ...(title ? { title } : {}),
    description: `${method} ${path}`,
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties,
      required
    },
    annotations: { readOnlyHint, destructiveHint: !readOnlyHint, openWorldHint: true },
    permissions: permissions ? { 'x-api-token-group': permissions } : {},
    request: {
      method,
      path,
      pathParams,
      queryParams,
      headerParams,
      cookieParams: [],
      ...(contentTypes.length
        ? {
            body: {
              contentType: contentTypes[0]!,
              content: Object.fromEntries(contentTypes.map((type) => [type, { encoding: {} }]))
            }
          }
        : {})
    }
  }
}

import { describe, expect, it } from 'vitest'
import { pathParam, tools, type Tool } from '../src/generated/forge-mcp'
import { cloudflareTool, permissionsOf } from '../src/forge-tools/cloudflare'
import {
  ACCOUNT_OR_ZONE_ID_DESCRIPTION,
  FORGE_ACCOUNT_ID_DESCRIPTION
} from '../src/forge-tools/policy'

/** A generated tool for `path`, with every path parameter required. */
function generated(path: string, extensions?: Tool['extensions']): Tool {
  const keys = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!)
  return {
    name: 'example',
    description: 'Example.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'object',
          properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])),
          required: keys
        }
      },
      required: ['path']
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    method: 'GET',
    path,
    ...(extensions && { extensions }),
    request: (args) => ({ path: path.replace(/\{([^}]+)\}/g, (_, key) => pathParam(args, key)) })
  }
}

/** The `path` argument of `tool`'s input schema. */
function pathOf(tool: Tool): {
  properties: Record<string, unknown>
  required?: string[]
} {
  return tool.inputSchema.properties?.path as {
    properties: Record<string, unknown>
    required?: string[]
  }
}

describe('the Cloudflare policy for generated tools', () => {
  it('makes path.account_id optional with one description', () => {
    const tool = cloudflareTool(generated('/accounts/{account_id}/workers/scripts/{script_name}'))

    expect(tool.inputSchema.properties?.path).toEqual({
      type: 'object',
      properties: {
        account_id: { type: 'string', description: FORGE_ACCOUNT_ID_DESCRIPTION },
        script_name: { type: 'string' }
      },
      required: ['script_name']
    })
    expect(tool.inputSchema.required).toEqual(['path'])
  })

  it('makes path optional when the account was its only required parameter', () => {
    const tool = cloudflareTool(generated('/accounts/{account_id}/d1/database'))

    expect(tool.inputSchema.properties?.path).not.toHaveProperty('required')
    expect(tool.inputSchema).not.toHaveProperty('required')
  })

  it('keeps a merged path’s account_or_zone and makes its account_or_zone_id optional', () => {
    const merged = generated('/{account_or_zone}/{account_or_zone_id}/access/apps')
    const path = pathOf(cloudflareTool(merged))

    expect(path.properties.account_or_zone).toBe(pathOf(merged).properties.account_or_zone)
    expect(path.properties.account_or_zone_id).toEqual({
      type: 'string',
      description: ACCOUNT_OR_ZONE_ID_DESCRIPTION
    })
    expect(path.required).toEqual(['account_or_zone'])
  })

  it('gets the two values of account_or_zone from the document (cloudflare/forge#59)', () => {
    const merged = tools.filter((tool) => tool.path.startsWith('/{account_or_zone}/'))

    expect(merged.length).toBeGreaterThan(0)
    for (const tool of merged) {
      expect(pathOf(tool).properties.account_or_zone).toMatchObject({
        type: 'string',
        enum: ['accounts', 'zones']
      })
    }
  })

  it('leaves other tools alone and keeps their request code', () => {
    const zone = generated('/zones/{zone_id}/dns_records')
    const account = generated('/accounts/{account_id}/d1/database')

    expect(cloudflareTool(zone)).toBe(zone)
    expect(cloudflareTool(account).request).toBe(account.request)
  })

  it('reads the permissions a method accepts', () => {
    expect(permissionsOf(generated('/a', { 'x-api-token-group': ['DNS Read'] }))).toEqual([
      'DNS Read'
    ])
    expect(permissionsOf(generated('/a', { 'x-api-token-group': 'DNS Read' }))).toBeUndefined()
    expect(permissionsOf(generated('/a'))).toBeUndefined()
  })

  it('leaves no generated tool requiring an account', () => {
    const requiring = tools
      .map(cloudflareTool)
      .filter((tool) =>
        (tool.inputSchema.properties?.path ? (pathOf(tool).required ?? []) : []).some(
          (key) => key === 'account_id' || key === 'account_or_zone_id'
        )
      )

    expect(requiring.map((tool) => tool.name)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { cloudflareTool } from '../src/forge-tools/cloudflare-plugin'
import {
  ACCOUNT_OR_ZONE_ID_DESCRIPTION,
  FORGE_ACCOUNT_ID_DESCRIPTION
} from '../src/forge-tools/policy'
import { fakeMethod, genericTool } from './helpers/forge-tools'

describe('Cloudflare forge-mcp plugin policy', () => {
  it('makes account_id optional with one description', () => {
    const tool = cloudflareTool(
      genericTool(
        'workers_scripts_get',
        'GET',
        '/accounts/{account_id}/workers/scripts/{script_name}'
      ),
      fakeMethod()
    )

    expect(tool.inputSchema.properties).toEqual({
      account_id: { type: 'string', description: FORGE_ACCOUNT_ID_DESCRIPTION },
      script_name: { type: 'string', description: 'Generic.' }
    })
    expect(tool.inputSchema.required).toEqual(['script_name'])
  })

  it('names the two values of a merged account-or-zone path', () => {
    const tool = cloudflareTool(
      genericTool('access_apps_list', 'GET', '/{account_or_zone}/{account_or_zone_id}/access/apps'),
      fakeMethod()
    )

    expect(tool.inputSchema.properties).toMatchObject({
      account_or_zone: { type: 'string', enum: ['accounts', 'zones'] },
      account_or_zone_id: { type: 'string', description: ACCOUNT_OR_ZONE_ID_DESCRIPTION }
    })
    expect(tool.inputSchema.required).toEqual(['account_or_zone'])
  })

  it('keeps accepted permissions in extensions, and leaves other tools alone', () => {
    const zoneTool = genericTool('dns_records_list', 'GET', '/zones/{zone_id}/dns_records')
    const withPermissions = cloudflareTool(
      zoneTool,
      fakeMethod({ 'x-api-token-group': ['DNS Read'] })
    )
    const without = cloudflareTool(zoneTool, fakeMethod({ 'x-api-token-group': 'not a list' }))

    expect(withPermissions.extensions).toEqual({ 'x-api-token-group': ['DNS Read'] })
    expect(withPermissions.inputSchema).toEqual(zoneTool.inputSchema)
    expect(without).toEqual(zoneTool)
  })
})

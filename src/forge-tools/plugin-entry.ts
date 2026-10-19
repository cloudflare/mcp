// The forge plugin that generates the Cloudflare direct-tool catalogue: the
// generic forge-mcp tools with the Cloudflare policy applied. Built into a
// QuickJS component by `npm run generate:tools`; the Worker never imports it.
import { definePlugin } from '@cloudflare/forge/plugin'
import { catalogueFile } from '@cloudflare/forge-mcp/plugin'
import { cloudflareTool } from './cloudflare-plugin'

export const { generate, generateGroup } = definePlugin({
  generate: (forge) => [catalogueFile(forge, { transform: cloudflareTool })]
})

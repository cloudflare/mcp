import { defineMcpApp } from '../mcp-apps/define'
import {
  D1_STUDIO_RESOURCE_URI,
  D1_STUDIO_TOOL_CONFIG,
  D1StudioInputSchema,
  D1StudioResultSchema
} from './contract'
import { appHtml } from './app-html.generated'

/** The D1 Studio App: a small SQL editor and table explorer for D1. */
export const d1StudioApp = defineMcpApp({
  name: 'd1_studio',
  ...D1_STUDIO_TOOL_CONFIG,
  input: D1StudioInputSchema,
  output: D1StudioResultSchema,
  resource: { uri: D1_STUDIO_RESOURCE_URI, name: 'D1 Studio', html: appHtml },
  async run() {
    return { ok: true, value: { kind: 'd1_studio' as const, message: 'Hello world' } }
  }
})

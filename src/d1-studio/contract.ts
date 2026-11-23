import { z } from 'zod'

/** The view's `ui://` resource. A permanent contract once hosts cache it. */
export const D1_STUDIO_RESOURCE_URI = 'ui://cloudflare/d1-studio.html'

export const D1StudioInputSchema = z.object({})
export type D1StudioInput = z.infer<typeof D1StudioInputSchema>

/** Scaffold output; replaced by the database's tables and query results. */
export const D1StudioResultSchema = z.object({
  kind: z.literal('d1_studio'),
  message: z.string()
})
export type D1StudioResult = z.infer<typeof D1StudioResultSchema>

export const D1_STUDIO_TOOL_CONFIG = {
  title: 'D1 Studio',
  description:
    'Open D1 Studio, a compact SQL editor and table explorer for a D1 database, in MCP Apps hosts. Scaffold: it shows a placeholder and reads nothing yet.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
}

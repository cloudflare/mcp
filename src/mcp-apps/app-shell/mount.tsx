import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@modelcontextprotocol/ext-apps'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { z } from 'zod'

/** How the host's state reaches the App's view. */
export interface MountedApp {
  /** The connected host bridge, for `callServerTool`, `sendMessage` and `updateModelContext`. */
  readonly app: App
}

export interface MountOptions<Output extends z.ZodType> {
  /** Shown to the host in `ui/initialize`. */
  readonly name: string
  readonly version?: string
  /** The tool's output schema; a result that doesn't match is shown as malformed, never guessed at. */
  readonly output: Output
  /** Render a validated result. */
  readonly render: (value: z.output<Output>, mounted: MountedApp) => ReactNode
  /** Render while the tool runs. Defaults to `copy.pending` as text. */
  readonly renderPending?: () => ReactNode
  /**
   * Render a tool error (`isError`), with its text. `retry` calls the tool
   * again with the same arguments, through the host, and renders what it
   * returns; it is absent when the host can't call server tools.
   */
  readonly renderError?: (text: string, retry: (() => void) | undefined) => ReactNode
  /** Copy for the states no tool result describes. Defaults are generic. */
  readonly copy?: Partial<Record<'pending' | 'cancelled' | 'malformed' | 'disconnected', string>>
}

function applyTheme(mode: string | undefined) {
  if (!mode) return
  document.documentElement.dataset.mode = mode
  document.documentElement.style.colorScheme = mode
}

/**
 * Mount an MCP App into `#root`: connect to the host, follow its theme, and
 * render each tool result that matches the output schema.
 *
 * Apps hold no credentials and make no network requests; everything they show
 * comes from the tool result. A result that fails validation, a cancelled call
 * and a lost host connection each get a plain message pointing at the tool's
 * text result, which every host shows.
 */
export function mountMcpApp<Output extends z.ZodType>(options: MountOptions<Output>): void {
  const copy = {
    pending: 'Loading…',
    cancelled: 'Cancelled.',
    malformed: 'This result could not be displayed. Check the tool’s text result.',
    disconnected: 'Could not connect to the host. The text result remains available.',
    ...options.copy
  }
  const root = createRoot(document.getElementById('root')!)
  const app = new App({ name: options.name, version: options.version ?? '1.0.0' }, {})
  const mounted: MountedApp = { app }

  const pending = () =>
    root.render(options.renderPending?.() ?? <p role="status">{copy.pending}</p>)
  let input: Record<string, unknown> | undefined
  const show = (result: CallToolResult) => {
    if (result.isError && options.renderError) {
      const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')
      const name = app.getHostContext()?.toolInfo?.tool.name
      const retry =
        name && app.getHostCapabilities()?.serverTools
          ? () => {
              pending()
              app
                .callServerTool({ name, arguments: input ?? {} })
                .then(show)
                .catch((error: unknown) =>
                  show({ isError: true, content: [{ type: 'text', text: String(error) }] })
                )
            }
          : undefined
      return root.render(options.renderError(text, retry))
    }
    const parsed = options.output.safeParse(result.structuredContent)
    root.render(
      parsed.success ? options.render(parsed.data, mounted) : <p role="alert">{copy.malformed}</p>
    )
  }

  pending()
  app.onhostcontextchanged = (context) => applyTheme(context.theme)
  app.ontoolinput = (params) => {
    input = params.arguments
  }
  app.ontoolresult = (result) => {
    applyTheme(app.getHostContext()?.theme)
    show(result)
  }
  app.ontoolcancelled = () => root.render(<p role="status">{copy.cancelled}</p>)
  app
    .connect()
    .then(() => applyTheme(app.getHostContext()?.theme))
    .catch(() => root.render(<p role="alert">{copy.disconnected}</p>))
}

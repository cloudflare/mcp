import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '@modelcontextprotocol/ext-apps'
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { z } from 'zod'
import { applyLocale } from './apply-locale'
import { resolveLocale } from './locale'

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
  /**
   * Render while the tool runs. Defaults to `copy.pending` as text. `toolName`
   * is the host's `toolInfo`, for an App one view serves for several tools;
   * it is absent until the host connects.
   */
  readonly renderPending?: (toolName: string | undefined) => ReactNode
  /**
   * Render a tool error (`isError`), with its text. `retry` calls the tool
   * again with the same arguments, through the host, and renders what it
   * returns; it is absent when the host can't call server tools.
   */
  readonly renderError?: (
    text: string,
    retry: (() => void) | undefined,
    toolName: string | undefined
  ) => ReactNode
  /** Copy for the states no tool result describes. Defaults are generic. */
  readonly copy?: Partial<Record<'pending' | 'cancelled' | 'malformed' | 'disconnected', string>>
  /**
   * The languages the App's copy is in, the default first. The host's
   * `locale` picks one (and so `lang` and `dir`); its region picks the number
   * and date formats. Defaults to English only. See `./locale.ts`.
   */
  readonly languages?: readonly [string, ...string[]]
}

function applyTheme(mode: string | undefined) {
  if (!mode) return
  document.documentElement.dataset.mode = mode
  document.documentElement.style.colorScheme = mode
}

/**
 * Mount an MCP App into `#root`: connect to the host, follow its theme and locale, and
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

  // The last thing drawn, so a locale change re-renders it in the new formats and direction.
  let last: () => ReactNode = () => null
  const draw = (node: () => ReactNode) => {
    last = node
    root.render(node())
  }
  const followHost = () => {
    const context = app.getHostContext()
    applyTheme(context?.theme)
    if (applyLocale(resolveLocale(context?.locale, options.languages ?? ['en'])))
      root.render(last())
  }
  const toolName = () => app.getHostContext()?.toolInfo?.tool.name
  // Drawn again on connect (`followHost` redraws the last thing), when the tool's name is known.
  const pending = () =>
    draw(() => options.renderPending?.(toolName()) ?? <p role="status">{copy.pending}</p>)
  let input: Record<string, unknown> | undefined
  const show = (result: CallToolResult) => {
    if (result.isError && options.renderError) {
      const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')
      const name = toolName()
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
      return draw(() => options.renderError!(text, retry, toolName()))
    }
    const parsed = options.output.safeParse(result.structuredContent)
    draw(() =>
      parsed.success ? options.render(parsed.data, mounted) : <p role="alert">{copy.malformed}</p>
    )
  }

  pending()
  app.onhostcontextchanged = followHost
  app.ontoolinput = (params) => {
    input = params.arguments
  }
  app.ontoolresult = (result) => {
    followHost()
    show(result)
  }
  app.ontoolcancelled = () => draw(() => <p role="status">{copy.cancelled}</p>)
  app
    .connect()
    .then(() => {
      followHost()
      // Now with the host's `toolInfo`: the pending view can name its tool.
      root.render(last())
    })
    .catch(() => draw(() => <p role="alert">{copy.disconnected}</p>))
}

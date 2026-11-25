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
   * it is absent until the host connects. `input` is the call's arguments once
   * the host sends them (`ui/notifications/tool-input`), so the pending view
   * can show what is running; it is absent before that.
   */
  readonly renderPending?: (
    toolName: string | undefined,
    input: Record<string, unknown> | undefined
  ) => ReactNode
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
  /**
   * The view's height to report to the host, in px. Defaults to the SDK's
   * (the document at `max-content`). An App whose view stretches to fill a
   * frame taller than itself reports its natural height instead, or the
   * frame could never shrink back to it.
   */
  readonly measure?: () => number
}

function applyTheme(mode: string | undefined) {
  if (!mode) return
  document.documentElement.dataset.mode = mode
  document.documentElement.style.colorScheme = mode
}

/** Set `data-display` (`inline`, `fullscreen`, `pip`) for CSS. True when it changed, so the view redraws. */
function applyDisplayMode(mode: string | undefined): boolean {
  if (!mode || document.documentElement.dataset.display === mode) return false
  document.documentElement.dataset.display = mode
  return true
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
  const app = new App(
    { name: options.name, version: options.version ?? '1.0.0' },
    {},
    { autoResize: !options.measure }
  )
  const mounted: MountedApp = { app }

  // The last thing drawn, so a locale change re-renders it in the new formats and direction.
  let last: () => ReactNode = () => null
  const draw = (node: () => ReactNode) => {
    last = () => {
      drawnFor = toolName()
      return node()
    }
    root.render(last())
  }
  const toolName = () => app.getHostContext()?.toolInfo?.tool.name
  // The tool name last drawn with: the pending and error views depend on it, and it can arrive late.
  let drawnFor: string | undefined
  const followHost = () => {
    const context = app.getHostContext()
    applyTheme(context?.theme)
    const relocalised = applyLocale(resolveLocale(context?.locale, options.languages ?? ['en']))
    const redisplayed = applyDisplayMode(context?.displayMode)
    if (relocalised || redisplayed || toolName() !== drawnFor) root.render(last())
  }
  let input: Record<string, unknown> | undefined
  const pending = () =>
    draw(() => options.renderPending?.(toolName(), input) ?? <p role="status">{copy.pending}</p>)
  // The pending view is the only one drawn from the input; a result or error already on screen stays.
  let settled = false
  // A result or error has been drawn: a late cancel or a failed connect doesn't take it off the screen.
  let answered = false
  const show = (result: CallToolResult) => {
    settled = true
    answered = true
    if (result.isError && options.renderError) {
      const text = result.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')
      // Decided at each draw, from the host's current context: `toolInfo` can arrive after the error.
      // Only with the call's own arguments: a retry without them would run the tool on nothing.
      const retryFor = (name: string | undefined) =>
        name && input && app.getHostCapabilities()?.serverTools
          ? () => {
              settled = false
              pending()
              app
                .callServerTool({ name, arguments: input ?? {} })
                .then(show)
                .catch((error: unknown) =>
                  show({ isError: true, content: [{ type: 'text', text: String(error) }] })
                )
            }
          : undefined
      return draw(() => options.renderError!(text, retryFor(toolName()), toolName()))
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
    // Settled, the view on screen stays; redrawn, an error offers Try again now that the arguments are known.
    if (!settled) pending()
    else root.render(last())
  }
  app.ontoolresult = (result) => {
    followHost()
    show(result)
  }
  app.ontoolcancelled = () => {
    if (answered) return
    // Settled: a late tool-input doesn't bring the pending view back.
    settled = true
    draw(() => <p role="status">{copy.cancelled}</p>)
  }
  app.connect().then(
    // With the host's `toolInfo` now known, `followHost` redraws the pending view for its tool.
    () => {
      followHost()
      if (options.measure) reportSize(app, options.measure)
    },
    // Only the connect failing: a throw in the redraw above isn't a lost host.
    () => {
      if (!answered) draw(() => <p role="alert">{copy.disconnected}</p>)
    }
  )
}

/** Report `measure()` to the host whenever the document's size may have changed, once a frame. */
function reportSize(app: App, measure: () => number) {
  let queued = false
  let width = 0
  let height = 0
  const send = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      const h = Math.ceil(measure())
      const w = Math.ceil(window.innerWidth)
      if (w === width && h === height) return
      width = w
      height = h
      void app.sendSizeChanged({ width: w, height: h }).catch(() => undefined)
    })
  }
  send()
  const ro = new ResizeObserver(send)
  ro.observe(document.documentElement)
  ro.observe(document.body)
  // Content that changes without resizing the document (a card that fills the frame) still changes what is measured.
  new MutationObserver(send).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true
  })
}

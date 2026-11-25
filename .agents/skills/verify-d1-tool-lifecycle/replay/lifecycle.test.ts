/**
 * Replays the model's paths (model/D1ToolLifecycle.tla) against the real
 * `mountMcpApp` in src/mcp-apps/app-shell/mount.tsx, one handler call per
 * model action.
 *
 * Fakes: the ext-apps `App` (records the handlers mount.tsx assigns, and lets
 * the test settle `connect()` and each `callServerTool`), `react-dom/client`
 * (records what `root.render` gets) and a minimal `document`. Nothing else in
 * mount.tsx is replaced. The options mirror D1 Studio's `mountMcpApp` call in
 * src/d1-studio/app/d1-studio-app.tsx (renderPending / renderError with its
 * retry), except `measure` (reportSize needs a real DOM) and the output schema
 * (a small stand-in; the lifecycle does not depend on its shape).
 *
 * Set MOUNT_PATH to run the same replays against a scratch copy of mount.tsx.
 *
 * Run: bun test .agents/skills/verify-d1-tool-lifecycle/replay
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { z } from 'zod'

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
const deferred = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Ctx = { toolInfo?: { tool: { name: string } } } | undefined
class FakeApp {
  static last: FakeApp
  ontoolinput?: (p: { arguments?: Record<string, unknown> }) => void
  ontoolresult?: (r: unknown) => void
  ontoolcancelled?: (p: unknown) => void
  onhostcontextchanged?: (p: unknown) => void
  context: Ctx = undefined
  caps: { serverTools?: object } | undefined = undefined
  connection = deferred<void>()
  calls: { args: unknown; d: Deferred<unknown> }[] = []
  constructor() {
    FakeApp.last = this
  }
  getHostContext() {
    return this.context
  }
  getHostCapabilities() {
    return this.caps
  }
  connect() {
    return this.connection.promise
  }
  callServerTool(params: { name: string; arguments: unknown }) {
    const d = deferred<unknown>()
    this.calls.push({ args: params.arguments, d })
    return d.promise
  }
  sendSizeChanged() {
    return Promise.resolve()
  }
}

let drawn: unknown
mock.module('@modelcontextprotocol/ext-apps', () => ({ App: FakeApp }))
mock.module('react-dom/client', () => ({
  createRoot: () => ({ render: (node: unknown) => (drawn = node) })
}))
;(globalThis as any).document = {
  getElementById: () => ({}),
  documentElement: { dataset: {}, style: {}, lang: '', dir: '' }
}

let mountMcpApp: (o: any) => void
beforeAll(async () => {
  const path = process.env.MOUNT_PATH ?? '../../../../src/mcp-apps/app-shell/mount'
  mountMcpApp = (await import(path)).mountMcpApp
})

type View =
  | { view: 'loading'; input: unknown }
  | { view: 'error'; text: string; retry?: () => void }
  | { view: 'answer'; value: unknown }
const screen = (): string => {
  const v = drawn as any
  if (v?.view) return v.view
  const text = v?.props?.children
  if (text === 'Cancelled.') return 'cancelled'
  if (typeof text === 'string' && text.startsWith('Could not connect')) return 'disconnected'
  if (typeof text === 'string' && text.startsWith('This result could not')) return 'answer'
  return `unknown:${JSON.stringify(v)}`
}
const retryButton = () => (drawn as any)?.retry as (() => void) | undefined
const tick = () => new Promise((r) => setTimeout(r, 0))

/** Mount the view the way D1 Studio does, and return the host side. */
function mount() {
  mountMcpApp({
    name: 'D1 Studio',
    output: z.object({ answer: z.number() }),
    copy: { pending: 'Running the query…' },
    renderPending: (_tool: unknown, input: unknown): View => ({ view: 'loading', input }),
    renderError: (text: string, retry?: () => void): View => ({ view: 'error', text, retry }),
    render: (value: unknown): View => ({ view: 'answer', value })
  })
  const app = FakeApp.last
  return {
    app,
    async connectSucceeds(toolKnown = true, serverTools = true) {
      app.context = toolKnown ? { toolInfo: { tool: { name: 'd1_studio' } } } : {}
      app.caps = serverTools ? { serverTools: {} } : {}
      app.connection.resolve()
      await tick()
    },
    async connectFails() {
      app.connection.reject(new Error('initialize timed out'))
      await tick()
    },
    hostContextChanged(ctx: Ctx) {
      app.context = { ...app.context, ...ctx }
      app.onhostcontextchanged!(ctx)
    },
    hostToolInput: (args = { sql: 'SELECT 1' }) => app.ontoolinput!({ arguments: args }),
    hostToolResult: (kind: 'answer' | 'error', answer = 0) =>
      app.ontoolresult!(
        kind === 'error'
          ? { isError: true, content: [{ type: 'text', text: 'D1 said no' }] }
          : { content: [], structuredContent: { answer } }
      ),
    hostToolCancelled: () => app.ontoolcancelled!({ reason: 'user stopped it' }),
    userRetries() {
      const retry = retryButton()
      if (!retry) throw new Error(`no Try again on screen (${screen()})`)
      retry()
    },
    async retryReturns(k: number, kind: 'answer' | 'error', answer = k) {
      const { d } = app.calls[k - 1]!
      d.resolve(
        kind === 'error'
          ? { isError: true, content: [{ type: 'text', text: `retry ${k} failed` }] }
          : { content: [], structuredContent: { answer } }
      )
      await tick()
    }
  }
}

describe('fixed: rules that used to break with an out-of-order host (AnyOrder.cfg)', () => {
  test('NoLoadingAfterCancel: tool-cancelled then tool-input stays "Cancelled."', async () => {
    const h = mount()
    await h.connectSucceeds()
    h.hostToolCancelled()
    h.hostToolInput()
    expect(screen()).toBe('cancelled')
  })

  test('ConnectFailKeepsAnswer: a tool-result before a failed connect stays on screen', async () => {
    const h = mount()
    h.hostToolResult('answer', 7)
    await h.connectFails()
    expect(screen()).toBe('answer')
  })

  test('ConnectFailKeepsAnswer: a failed connect with nothing answered still says so', async () => {
    const h = mount()
    await h.connectFails()
    expect(screen()).toBe('disconnected')
  })

  test('CancelKeepsAnswer: tool-cancelled after the result leaves it on screen', async () => {
    const h = mount()
    await h.connectSucceeds()
    h.hostToolInput()
    h.hostToolResult('answer', 7)
    h.hostToolCancelled()
    expect(screen()).toBe('answer')
  })

  test('RetrySameArguments: no Try again before tool-input, so no call with {}', async () => {
    const h = mount()
    await h.connectSucceeds()
    h.hostToolResult('error')
    expect(retryButton()).toBeUndefined()
    expect(h.app.calls).toHaveLength(0)
  })
})

describe('rules that hold: the paths that come closest', () => {
  test('InputKeepsAnswer: a late tool-input leaves the result and the error on screen', async () => {
    for (const kind of ['answer', 'error'] as const) {
      const h = mount()
      await h.connectSucceeds()
      h.hostToolResult(kind)
      h.hostToolInput()
      expect(screen()).toBe(kind)
    }
  })

  test('LatestCallShown: Try again draws pending, so no second Try again while one runs', async () => {
    const h = mount()
    await h.connectSucceeds()
    h.hostToolInput()
    h.hostToolResult('error')
    h.userRetries()
    expect(screen()).toBe('loading')
    expect(retryButton()).toBeUndefined()
    await h.retryReturns(1, 'error')
    h.userRetries()
    await h.retryReturns(2, 'answer', 2)
    expect((drawn as any).value).toEqual({ answer: 2 })
  })

  test('RetryOfferedWhenPossible: toolInfo arriving after the error adds Try again', async () => {
    const h = mount()
    await h.connectSucceeds(false, true)
    h.hostToolInput()
    h.hostToolResult('error')
    expect(retryButton()).toBeUndefined()
    h.hostContextChanged({ toolInfo: { tool: { name: 'd1_studio' } } })
    expect(typeof retryButton()).toBe('function')
  })

  test('RetryOfferedWhenPossible: tool-input after the error adds Try again with its arguments', async () => {
    const h = mount()
    await h.connectSucceeds()
    h.hostToolResult('error')
    expect(retryButton()).toBeUndefined()
    h.hostToolInput({ sql: 'SELECT 2' })
    expect(screen()).toBe('error')
    h.userRetries()
    expect(h.app.calls[0]!.args).toEqual({ sql: 'SELECT 2' })
  })

  test('Compliant order: cancel during the call stays "Cancelled."', async () => {
    const h = mount()
    await h.connectSucceeds()
    h.hostToolInput()
    h.hostToolCancelled()
    h.hostContextChanged({})
    expect(screen()).toBe('cancelled')
  })
})

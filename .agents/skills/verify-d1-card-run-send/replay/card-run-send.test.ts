/**
 * Replays the model's paths (model/CardRunSend.tla) against the real, pure
 * `cardReducer`, one event per model step, with the events the UI dispatches:
 *
 * - "you open the editor": the tray's onClick, `dispatch({ type: 'pane.toggle' })` (d1-studio-app.tsx)
 * - "you edit the SQL": the Editor textarea's onChange, `draft.change`
 * - "you press ⌘↵": the Editor's onKeyDown calls `submitKey` (~l.1710; console.tsx ~l.797): Copy SQL when
 *   `copyIsPrimary(state)`, else `submit`. `pressCmdEnter` below mirrors those two functions, because
 *   d1-studio-app.tsx mounts the app when imported (it needs a DOM). Recheck them when the file's hash changes.
 * - "you click Send to chat / Run": `RunButton`'s onClick, `submit` behind its own guards
 * - "you page the query's LIMIT": the pager arrows, `offset`
 * - "you click Revert": `revert`, offered when `canRevert`
 * - "you come back from fullscreen": `Studio`'s effect dispatches `fold`. The machine lives in `useAnswerCard`,
 *   called by `Studio`, so it is not remounted.
 * - host replies: `useRunEffects` dispatches `run.done` / `run.error` / `send.done` / `send.error`, and
 *   `send.timeout` after SEND_TIMEOUT_MS. It starts a d1_raw read when the run turns `running`, and posts
 *   `ui/message` when it turns `sending` (keyed on the run's id).
 *
 * Each former finding (fixed after the first sync) is now a plain test that asserts the fixed behavior on the old
 * bug path. If a new finding comes up, write it as `finding(...)` (bun `test.failing`: it passes while the code
 * breaks the rule). SHOW_FINDINGS=1 runs findings as plain tests, so you can read where each one fails.
 * D1_STUDIO_APP points the replay at another copy of `src/d1-studio/app` (for the skill's scratch-break check).
 */
import { describe, expect, test } from 'bun:test'
import type { D1Outcome, D1Query } from '../../../../src/d1-studio/contract'
import type * as Machines from '../../../../src/d1-studio/app/machines'
import type * as Verdicts from '../../../../src/d1-studio/app/verdict'

const app = process.env.D1_STUDIO_APP ?? `${import.meta.dir}/../../../../src/d1-studio/app`
const { cardReducer, initialCard, isBusy, canRevert } = (await import(
  `${app}/machines.ts`
)) as typeof Machines
const { verdictOf } = (await import(`${app}/verdict.ts`)) as typeof Verdicts
export const finding = process.env.SHOW_FINDINGS ? test : test.failing
type CardState = Machines.CardState
type CardEvent = Machines.CardEvent

const rows = (n: number): D1Outcome => ({
  status: 'rows',
  columns: ['name', 'n'],
  rows: Array.from({ length: n }, (_, i) => [`r${i}`, i]),
  rowCount: n,
  meta: { durationMs: 1, rowsRead: n, rowsWritten: 0 }
})
// The agent's answer: a small LIMIT that came back full, so the band pages it by OFFSET (limitPaging).
const query: D1Query = {
  purpose: 'query',
  title: 'Top',
  sql: 'SELECT name, n FROM t LIMIT 10',
  outcome: rows(10)
}
const WRITE = 'DELETE FROM t WHERE n = 3'

/** d1-studio-app.tsx `copyIsPrimary(state)`, mirrored. */
const copyIsPrimary = (s: CardState) =>
  verdictOf(s.draft).kind === 'write' &&
  (!s.can.send || s.run.status === 'unconfirmed' || s.run.status === 'refused')

/** What the effects did, so the replay can check what reached d1_raw and the chat. */
interface World {
  state: CardState
  reads: string[] // SQL handed to runRead (d1_raw)
  posts: { id: number; sql: string }[] // ui/message posts
  copies: number // ⌘↵ that copied the SQL instead
}

/** The answer card's machine (useAnswerCard), with useRunEffects' keyed-on-id behavior around the pure reducer. */
function card(host: { run: boolean; send: boolean }) {
  const w: World = {
    state: initialCard(query, { run: host.run, send: host.send }, 0),
    reads: [],
    posts: [],
    copies: 0
  }
  const key = (s: CardState) => (isBusy(s.run) && 'id' in s.run ? s.run.id : undefined)
  const dispatch = (e: CardEvent) => {
    const before = w.state
    w.state = cardReducer(before, e)
    if (key(w.state) !== key(before)) {
      if (w.state.run.status === 'running') w.reads.push(w.state.run.sql)
      if (w.state.run.status === 'sending') w.posts.push({ id: w.state.run.id, sql: w.state.run.sql })
    }
    return w
  }
  /** submitKey(state, dispatch, el), mirrored. */
  const pressCmdEnter = () => {
    if (copyIsPrimary(w.state)) w.copies++
    else dispatch({ type: 'submit' })
    return w
  }
  return Object.assign(w, { dispatch, pressCmdEnter })
}

const both = { run: true, send: true }

describe('AbandonedReplyIgnored: a reply to an abandoned run or send never changes the card', () => {
  test('Revert, then the late read lands', () => {
    const c = card(both)
    c.dispatch({ type: 'pane.toggle' })
    c.dispatch({ type: 'draft.change', draft: 'SELECT 1' })
    c.pressCmdEnter() // running, id 1
    c.dispatch({ type: 'revert' })
    const after = c.state
    for (const e of [
      { type: 'run.done', id: 1, outcome: rows(2), at: 1 },
      { type: 'run.error', id: 1, error: 'x' }
    ] as CardEvent[])
      expect(c.dispatch(e).state).toBe(after)
  })
  test('Revert after "Waiting on host", then the late send replies land', () => {
    // Revert is refused while Sending now; it is offered again once the card says it couldn't confirm.
    const c = card(both)
    c.dispatch({ type: 'pane.toggle' })
    c.dispatch({ type: 'draft.change', draft: WRITE })
    c.pressCmdEnter() // sending, id 1
    c.dispatch({ type: 'send.timeout', id: 1 }) // unconfirmed
    expect(canRevert(c.state)).toBe(true)
    c.dispatch({ type: 'revert' })
    const after = c.state
    for (const e of [
      { type: 'send.timeout', id: 1 },
      { type: 'send.done', id: 1 },
      { type: 'send.error', id: 1, error: 'x' }
    ] as CardEvent[])
      expect(c.dispatch(e).state).toBe(after)
  })
  test('a new run, then the old run lands', () => {
    const c = card(both)
    c.dispatch({ type: 'pane.toggle' })
    c.dispatch({ type: 'draft.change', draft: 'SELECT 1' })
    c.pressCmdEnter() // running, id 1
    c.dispatch({ type: 'revert' })
    c.dispatch({ type: 'draft.change', draft: 'SELECT 2' })
    c.pressCmdEnter() // running, id 2
    const after = c.state
    expect(c.dispatch({ type: 'run.done', id: 1, outcome: rows(1), at: 1 }).state).toBe(after)
  })
})

describe('OnlyReadsRun: only a read is ever run', () => {
  test('⌘↵ on a write, a typo, two statements, empty; run.sql with a write: nothing reaches d1_raw', () => {
    for (const draft of [WRITE, 'SELEC 1', 'SELECT 1; SELECT 2', '']) {
      const c = card(both)
      c.dispatch({ type: 'pane.toggle' })
      c.dispatch({ type: 'draft.change', draft })
      c.pressCmdEnter()
      c.dispatch({ type: 'run.sql', sql: WRITE })
      expect(c.reads).toEqual([])
    }
  })
})

describe('SendAlwaysTimed: a send never waits forever', () => {
  test('Sending turns to unconfirmed (Copy SQL) on send.timeout; a late send.done still lands', () => {
    const c = card(both)
    c.dispatch({ type: 'pane.toggle' })
    c.dispatch({ type: 'draft.change', draft: WRITE })
    c.pressCmdEnter()
    expect(c.dispatch({ type: 'send.timeout', id: 1 }).state.run.status).toBe('unconfirmed')
    expect(c.dispatch({ type: 'send.done', id: 1 }).state.run.status).toBe('sent')
  })
})

describe('WriteReachesChatOnce: a write reaches the chat at most once unless the draft changes (fixed)', () => {
  test('the old path: ⌘↵ in Sent no longer posts the same write again', () => {
    const c = card(both)
    c.dispatch({ type: 'pane.toggle' })
    c.dispatch({ type: 'draft.change', draft: WRITE })
    c.pressCmdEnter()
    c.dispatch({ type: 'send.done', id: 1 })
    expect(c.state.run.status).toBe('sent')
    c.pressCmdEnter() // submit is refused while isHandedOff
    expect(c.posts).toHaveLength(1)
  })
  test('the old path: ⌘↵ while "Waiting on host (Copy SQL offered)" copies instead of sending', () => {
    const c = card(both)
    c.dispatch({ type: 'pane.toggle' })
    c.dispatch({ type: 'draft.change', draft: WRITE })
    c.pressCmdEnter()
    c.dispatch({ type: 'send.timeout', id: 1 })
    c.pressCmdEnter()
    expect(c.copies).toBe(1)
    expect(c.posts).toHaveLength(1)
    c.dispatch({ type: 'submit' }) // even a bare submit is refused while unconfirmed
    expect(c.posts).toHaveLength(1)
  })
})

describe('ChatGotItCardSaysSo: the card stays on a write the chat may have until it says Sent or that it could not confirm (fixed)', () => {
  test('the old path: Revert while Sending is refused, so the chat taking it shows Sent', () => {
    const c = card(both)
    c.dispatch({ type: 'pane.toggle' })
    c.dispatch({ type: 'draft.change', draft: WRITE })
    c.pressCmdEnter()
    expect(canRevert(c.state)).toBe(false) // Revert isn't offered while Sending
    c.dispatch({ type: 'revert' })
    expect(c.state.run.status).toBe('sending')
    c.dispatch({ type: 'send.done', id: 1 })
    expect(c.state.run.status).toBe('sent')
  })
  test('the old path: fullscreen and back while Sending keeps the send (no remount; fold only)', () => {
    const c = card(both)
    c.dispatch({ type: 'pane.toggle' })
    c.dispatch({ type: 'draft.change', draft: WRITE })
    c.pressCmdEnter()
    c.dispatch({ type: 'send.done', id: 1 }) // lands while fullscreen: the machine lives in Studio
    c.dispatch({ type: 'fold' }) // back from fullscreen
    expect(c.state.run.status).toBe('sent')
    expect(c.state.draft).toBe(WRITE)
  })
})

describe('RunsOnlyWhereHostRuns / SendsOnlyWhereHostSends: the view calls only what the host advertises (fixed)', () => {
  const sendOnly = { run: false, send: true }
  const runOnly = { run: true, send: false }
  test('the old path: on a host without serverTools the LIMIT pager runs nothing', () => {
    const c = card(sendOnly)
    c.dispatch({ type: 'offset', offset: 10 })
    expect(c.reads).toEqual([])
  })
  test("the old path: on a host without serverTools ⌘↵ on the agent's read runs nothing", () => {
    const c = card(sendOnly)
    c.dispatch({ type: 'pane.toggle' })
    c.pressCmdEnter()
    expect(c.reads).toEqual([])
  })
  test('the old path: on a host without messages ⌘↵ on a write copies; a bare submit posts nothing', () => {
    const c = card(runOnly)
    c.dispatch({ type: 'pane.toggle' })
    c.dispatch({ type: 'draft.change', draft: WRITE })
    c.pressCmdEnter()
    expect(c.copies).toBe(1)
    c.dispatch({ type: 'submit' })
    expect(c.posts).toEqual([])
  })
})

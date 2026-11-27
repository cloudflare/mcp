/**
 * D1 Studio's view state, as explicit machines. Pure: no React, DOM or host,
 * so tests drive them directly. Each machine is a union of the states it can
 * be in, a union of the events it accepts, and a reducer that ignores an
 * event its current state doesn't accept (a stale reply, a double click),
 * rather than reaching an impossible combination of flags.
 *
 * - {@link CardState}: one query card: its rows disclosure, its SQL pane
 *   (short, as written, or the editor), the result on screen (the agent's or
 *   the user's re-run), the run or chat hand-off in flight, and the sort.
 * - {@link CopyState}: the copy trio's feedback.
 * - {@link cardKind}: what a card shows, derived from its query and run,
 *   never stored, so it can't disagree with them.
 */
import { MAX_ROWS, type D1Cell, type D1Outcome, type D1Query } from '../contract'
import { limitOf, verdictOf, withOffset, type Verdict } from './verdict'

// ── What a card shows ──

/**
 * - `running`: the agent's call hasn't returned (the pending view).
 * - `rows`: a result with at least one row.
 * - `none`: a query that returned no rows.
 * - `empty-db`: the table listing returned none: the database has no tables.
 * - `error`: D1 refused the SQL.
 */
export type CardKind = 'running' | 'rows' | 'none' | 'empty-db' | 'error'

/** The kind of a query's outcome; `null` is the agent's call still running. */
export function cardKind(purpose: D1Query['purpose'], outcome: D1Outcome | null): CardKind {
  if (!outcome) return 'running'
  if (outcome.status === 'failed') return 'error'
  if (outcome.rows.length) return 'rows'
  return purpose === 'tables' ? 'empty-db' : 'none'
}

// ── Sort: the rows on screen, reordered in the view. Costs no query. ──

export type Sort = { readonly column: number; readonly dir: 'asc' | 'desc' } | null

/** Ascending, descending, then back to the order the query returned. */
export function nextSort(sort: Sort, column: number): Sort {
  if (sort?.column !== column) return { column, dir: 'asc' }
  return sort.dir === 'asc' ? { column, dir: 'desc' } : null
}

/**
 * The rows in `sort` order. NULLs stay last both ways; two numbers compare
 * as numbers, anything else as text with numeric collation. Stable, so equal
 * values keep the query's order.
 */
export function sortRows(
  rows: readonly (readonly D1Cell[])[],
  sort: Sort
): readonly (readonly D1Cell[])[] {
  if (!sort) return rows
  const { column } = sort
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = a[column] ?? null
    const y = b[column] ?? null
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign
    return (
      String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }) * sign
    )
  })
}

// ── One query card ──

/** The result on screen: the agent's, which never changes, or the user's own re-run laid over it. `readAt` is when D1 answered. */
export type Shown =
  | { readonly source: 'agent'; readonly readAt: number }
  | {
      readonly source: 'rerun'
      readonly sql: string
      readonly outcome: D1Outcome
      readonly readAt: number
    }

/** Rows count as old this long after D1 answered. Under it a re-read is a no-op, so nothing says so. */
export const STALE_AFTER_MS = 10 * 60_000

/** The rows a page of the open table shows. */
export const PAGE_ROWS = 10

/** The rows a page of the fullscreen console's result shows, scrolled inside it. */
export const CONSOLE_PAGE_ROWS = 100

type Rows = readonly (readonly D1Cell[])[]

/** How long the view waits for the host to confirm a message before it offers Copy SQL instead. */
export const SEND_TIMEOUT_MS = 5_000

/**
 * What the last run found, against the rows on screen before it:
 * - `agent`: nothing ran here; the agent's result is on screen.
 * - `same` / `changed` / `count`: the agent's own SQL read again. `changed`
 *   holds each moved row's old values by column, keyed by the new row.
 * - `edited`: the user's SQL ran. `failed`: the run came back as a SQL error.
 */
export type Found =
  | { readonly kind: 'agent' }
  | { readonly kind: 'same' }
  | {
      readonly kind: 'changed'
      readonly cells: number
      readonly was: ReadonlyMap<readonly D1Cell[], ReadonlyMap<number, D1Cell>>
    }
  | { readonly kind: 'count'; readonly before: number; readonly after: number }
  | { readonly kind: 'edited' }
  | { readonly kind: 'failed' }

/**
 * Reading more of a result the tool cut at MAX_ROWS, in the view (`d1_raw`,
 * no model turn), a block of MAX_ROWS at a time:
 * - `idle`: nothing in flight.
 * - `paging`: the block at `offset` that `page` is in; the page being left stays on screen. Going to a row can
 *   skip blocks, so what is held can have holes.
 * - `sorting`: the whole result sorted by D1 (`sort`), since the view holds only part of it: the block at
 *   `offset` that `page` is in, in the new order. Sort and page combine, as in the dashboard's Studio: a page
 *   asked while D1 sorts is the page shown when it lands.
 * - `failed`: the read failed; the host's or D1's message.
 */
export type Fetch =
  | { readonly status: 'idle' }
  | {
      readonly status: 'paging'
      readonly id: number
      readonly page: number
      readonly offset: number
    }
  | {
      readonly status: 'sorting'
      readonly id: number
      readonly sort: Sort
      readonly page: number
      readonly offset: number
    }
  | { readonly status: 'failed'; readonly error: string }

/**
 * What the card is doing with the draft:
 * - `idle`: nothing in flight.
 * - `running`: a read is on its way through the host (`d1_raw`). The last
 *   result stays on screen so the card doesn't jump; only Run shows the wait.
 * - `sending`: a write is being handed to the chat (`ui/message`).
 * - `unconfirmed`: the host hasn't answered in SEND_TIMEOUT_MS (some never
 *   do); the view stops waiting and offers Copy SQL. A late answer still lands.
 * - `refused`: the host didn't take the message.
 * - `sent`: the chat has the write; the user approves it there.
 * - `failed`: the host couldn't run or send it (not a SQL error, which is a
 *   re-run outcome). The message is the host's.
 */
export type Run =
  | { readonly status: 'idle' }
  | { readonly status: 'running'; readonly id: number; readonly sql: string }
  | { readonly status: 'sending'; readonly id: number; readonly sql: string }
  | { readonly status: 'unconfirmed'; readonly id: number; readonly sql: string }
  | { readonly status: 'refused'; readonly sql: string }
  | { readonly status: 'sent'; readonly sql: string }
  | { readonly status: 'failed'; readonly error: string }

export interface CardState {
  /** The agent's query; immutable. */
  readonly query: D1Query
  /** When D1 answered the agent's query, so Revert brings back the rows' age with them. */
  readonly agentReadAt: number
  /**
   * Whether this card's SQL can be edited at all: the answer card in a host
   * that can run reads or send messages. Fixed for the card's life.
   */
  readonly editable: boolean
  /**
   * What the host lets the card do with the draft, fixed for the card's life:
   * run a read (`serverTools`), hand a write to the chat (`message`).
   * `editable` is either.
   */
  readonly can: { readonly run: boolean; readonly send: boolean }
  readonly rows: 'closed' | 'open'
  /** `short`: folded, a clause per line. `full`: as written, which is the editor when `editable`. */
  readonly pane: 'short' | 'full'
  /** The editor's text. Starts as the agent's SQL; kept when the pane folds. */
  readonly draft: string
  readonly shown: Shown
  readonly run: Run
  /** The order on screen. Held whole, the view sorted the rows; held in part, D1 did (`held` is in this order). */
  readonly sort: Sort
  /** What the last run found, for the receipt and the changed cells' marks. */
  readonly found: Found
  /** The page of the open table, 0-based. */
  readonly page: number
  /**
   * The rows held when they differ from the outcome's, by block of MAX_ROWS:
   * read past the tool's first block, or sorted by D1. Each block is in the
   * order on screen.
   */
  readonly held: ReadonlyMap<number, Rows> | null
  readonly fetch: Fetch
  /** Rows a page shows: PAGE_ROWS on the card, CONSOLE_PAGE_ROWS in the fullscreen console. */
  readonly pageSize: number
  /** The id the next run, send or read gets, so a late reply to an abandoned one is ignored. */
  readonly nextId: number
}

export type CardEvent =
  | { readonly type: 'rows.toggle' }
  | { readonly type: 'rows.close' }
  /** Back to the closed card (back from fullscreen): rows closed, SQL folded; the draft and anything in flight stay. */
  | { readonly type: 'fold' }
  | { readonly type: 'pane.toggle' }
  | { readonly type: 'draft.change'; readonly draft: string }
  /** Run the draft if it's a read, or hand it to the chat if it writes. */
  | { readonly type: 'submit' }
  | {
      readonly type: 'run.done'
      readonly id: number
      readonly outcome: D1Outcome
      readonly at: number
    }
  | { readonly type: 'run.error'; readonly id: number; readonly error: string }
  | { readonly type: 'send.done'; readonly id: number }
  | { readonly type: 'send.error'; readonly id: number; readonly error: string }
  /** SEND_TIMEOUT_MS passed with the send still unanswered. */
  | { readonly type: 'send.timeout'; readonly id: number }
  /** Back to the agent's query and result; abandons anything in flight. */
  | { readonly type: 'revert' }
  | { readonly type: 'sort'; readonly column: number }
  /** Turn the open table's page; past the rows held, read the next ones. */
  | { readonly type: 'page'; readonly page: number }
  /** Page a query's own LIMIT: write OFFSET into its SQL and run it (the receipt shows what ran; Revert goes back). */
  | { readonly type: 'offset'; readonly offset: number }
  /** Run this read as the draft, wherever the pane is (a fix the card offers, such as `Use starts_at`). */
  | { readonly type: 'run.sql'; readonly sql: string }
  | { readonly type: 'fetch.done'; readonly id: number; readonly rows: Rows }
  /** The agent's SQL, read again elsewhere (a read let go of in the console), landed: show it as a refresh. */
  | { readonly type: 'reread'; readonly outcome: D1Outcome; readonly at: number }
  | { readonly type: 'fetch.error'; readonly id: number; readonly error: string }

/**
 * `can`: what the host lets the card do (`true` or `false` for both).
 * `readAt`: when D1 answered the agent's query.
 */
export function initialCard(
  query: D1Query,
  can: boolean | { readonly run: boolean; readonly send: boolean },
  readAt = Date.now()
): CardState {
  const abilities = typeof can === 'boolean' ? { run: can, send: can } : can
  return {
    query,
    agentReadAt: readAt,
    editable: abilities.run || abilities.send,
    can: abilities,
    rows: 'closed',
    pane: 'short',
    draft: query.sql,
    shown: { source: 'agent', readAt },
    run: { status: 'idle' },
    sort: null,
    found: { kind: 'agent' },
    page: 0,
    held: null,
    fetch: { status: 'idle' },
    pageSize: PAGE_ROWS,
    nextId: 1
  }
}

/** Same columns and row count: cell by cell, in order. Otherwise the count is what changed. */
export function compareOutcomes(before: D1Outcome, after: D1Outcome): Found {
  if (before.status !== 'rows' || after.status !== 'rows') return { kind: 'edited' }
  if (before.rowCount !== after.rowCount || before.rows.length !== after.rows.length)
    return { kind: 'count', before: before.rowCount, after: after.rowCount }
  if (before.columns.join('\u0000') !== after.columns.join('\u0000')) return { kind: 'edited' }
  const was = new Map<readonly D1Cell[], Map<number, D1Cell>>()
  let cells = 0
  after.rows.forEach((row, i) => {
    const old = before.rows[i]!
    row.forEach((v, c) => {
      if (v === (old[c] ?? null)) return
      cells++
      const m = was.get(row) ?? new Map<number, D1Cell>()
      m.set(c, old[c] ?? null)
      was.set(row, m)
    })
  })
  return cells ? { kind: 'changed', cells, was } : { kind: 'same' }
}

/** Whether a re-read moved what the user saw. */
export const moved = (found: Found) => found.kind === 'changed' || found.kind === 'count'

/** The receipt's words after "✓ Ran here", one spelling at every width. */
export function foundWords(found: Found): string | undefined {
  if (found.kind === 'same') return 'no change'
  if (found.kind === 'changed')
    return `${found.cells} ${found.cells === 1 ? 'value' : 'values'} changed`
  if (found.kind === 'count') return `now ${found.after} ${found.after === 1 ? 'row' : 'rows'}`
  return undefined
}

/** Revert only when there is something of the agent's to go back to: an edited draft, or rows from other SQL. */
export function canRevert(state: CardState): boolean {
  if (state.run.status === 'sending') return false
  return state.draft !== state.query.sql || shownSql(state) !== state.query.sql
}

export function isStale(state: CardState, now: number): boolean {
  return now - state.shown.readAt >= STALE_AFTER_MS
}

/** The rows' age, one spelling at every width: "25 min ago", "3h ago", "yesterday", "Nov 21". */
export function ageWords(ms: number, now: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  if (h < 48) return 'yesterday'
  return new Date(now - ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * The blocks of MAX_ROWS the view holds, in the order shown: the outcome's
 * (sorted in the view when held whole), or those read past them / sorted by D1.
 */
export function heldBlocks(state: CardState): ReadonlyMap<number, Rows> {
  if (state.held) return state.held
  const outcome = shownOutcome(state)
  if (outcome.status !== 'rows') return new Map()
  if (!isPartial(outcome)) return new Map([[0, sortRows(outcome.rows, state.sort)]])
  const blocks = new Map<number, Rows>()
  for (let b = 0; b * MAX_ROWS < outcome.rows.length; b++)
    blocks.set(b, outcome.rows.slice(b * MAX_ROWS, (b + 1) * MAX_ROWS))
  return blocks
}

/** Every row the view holds, in the order shown (what the copy trio copies). */
export function heldRows(state: CardState): Rows {
  const blocks = heldBlocks(state)
  return [...blocks.keys()].sort((a, b) => a - b).flatMap((b) => blocks.get(b)!)
}

/** Whether what is held runs from the first row without a hole, so it is "the first N". */
export function heldIsContiguous(state: CardState): boolean {
  const keys = [...heldBlocks(state).keys()]
  return keys.every((b) => b < keys.length)
}

/** The rows of one page, by their place in the whole result; a row not held is missing. */
export function pageRows(state: CardState, page: number): Rows {
  const outcome = shownOutcome(state)
  if (outcome.status !== 'rows') return []
  const blocks = heldBlocks(state)
  if (!isPartial(outcome) && !state.held)
    return (blocks.get(0) ?? []).slice(page * state.pageSize, (page + 1) * state.pageSize)
  const out: (readonly D1Cell[])[] = []
  const end = Math.min((page + 1) * state.pageSize, outcome.rowCount)
  for (let i = page * state.pageSize; i < end; i++) {
    const row = blocks.get(Math.floor(i / MAX_ROWS))?.[i % MAX_ROWS]
    if (row) out.push(row)
  }
  return out
}

/** The first block a page needs that isn't held, or undefined when every row of it is. */
function missingBlock(state: CardState, page: number): number | undefined {
  const outcome = shownOutcome(state)
  if (outcome.status !== 'rows') return undefined
  const blocks = heldBlocks(state)
  const first = Math.floor((page * state.pageSize) / MAX_ROWS)
  const last = Math.floor((Math.min((page + 1) * state.pageSize, outcome.rowCount) - 1) / MAX_ROWS)
  for (let b = first; b <= last; b++) if (!blocks.has(b)) return b
  return undefined
}

/**
 * A query's own LIMIT, when the band pages it by writing OFFSET into the SQL:
 * a small LIMIT (at most a page) that came back full, or one already offset.
 * No COUNT(*) is read, so nothing names a total.
 */
export function limitPaging(state: CardState): { limit: number; offset: number } | undefined {
  const outcome = shownOutcome(state)
  if (outcome.status !== 'rows' || isPartial(outcome) || !state.can.run) return undefined
  const { limit, offset } = limitOf(shownSql(state))
  if (!limit || limit > PAGE_ROWS) return undefined
  if (outcome.rows.length !== limit && offset === 0) return undefined
  return { limit, offset }
}

/** D1 returned more rows than the view holds, so sorting and later pages need D1. */
export function isPartial(outcome: D1Outcome): boolean {
  return outcome.status === 'rows' && outcome.rowCount > outcome.rows.length
}

export function pageCount(state: CardState): number {
  const outcome = shownOutcome(state)
  return outcome.status === 'rows' ? Math.ceil(outcome.rowCount / state.pageSize) : 0
}

/**
 * The agent's rows, kept (dimmed) under a read of the user's that D1
 * refused, so a typo loses no data and the card keeps its height.
 */
export function keptOutcome(state: CardState): Extract<D1Outcome, { status: 'rows' }> | undefined {
  const agent = state.query.outcome
  return state.shown.source === 'rerun' &&
    state.shown.outcome.status === 'failed' &&
    agent.status === 'rows' &&
    agent.rows.length > 0 &&
    cardKind(state.query.purpose, agent) === 'rows'
    ? agent
    : undefined
}

/** The outcome on screen. */
export function shownOutcome(state: CardState): D1Outcome {
  return state.shown.source === 'rerun' ? state.shown.outcome : state.query.outcome
}

/** The SQL whose result is on screen. */
export function shownSql(state: CardState): string {
  return state.shown.source === 'rerun' ? state.shown.sql : state.query.sql
}

/** Whether the card differs from what the agent ran: the draft changed, or a re-run is on screen. */
export function isEdited(state: CardState): boolean {
  return state.draft !== state.query.sql || state.shown.source === 'rerun'
}

/** The first row of the block of MAX_ROWS a page starts in. */
function blockOf(state: CardState, page: number): number {
  return Math.floor((page * state.pageSize) / MAX_ROWS) * MAX_ROWS
}

/** D1 sorts the whole result; the block `page` is in is read in that order (replacing any read in flight). */
function sortingAt(state: CardState, sort: Sort, page: number): CardState {
  const id = state.nextId
  return {
    ...state,
    fetch: { status: 'sorting', id, sort, page, offset: blockOf(state, page) },
    nextId: id + 1
  }
}

function isBusyFetch(fetch: Fetch): fetch is Extract<Fetch, { id: number }> {
  return fetch.status === 'paging' || fetch.status === 'sorting'
}

/** Whether the run or send in flight, if any. */
export function isBusy(run: Run): boolean {
  return run.status === 'running' || run.status === 'sending'
}

/** The chat has this draft, or may: sending it again would put the same write there twice. */
export function isHandedOff(run: Run): boolean {
  return run.status === 'sent' || run.status === 'unconfirmed'
}

/**
 * What submitting the draft would do: run it (one read), send it to the chat
 * (a real write), or nothing: an empty draft, or one Run can't take (text after
 * the `;`, several statements, a typo), which the reason line under the SQL
 * explains.
 */
export function submitAction(
  draft: string
): { kind: 'run' } | { kind: 'send'; verdict: Verdict } | { kind: 'none'; verdict: Verdict } {
  const verdict = verdictOf(draft)
  if (verdict.kind === 'read') return { kind: 'run' }
  if (verdict.kind === 'write') return { kind: 'send', verdict }
  return { kind: 'none', verdict }
}

export function cardReducer(state: CardState, event: CardEvent): CardState {
  switch (event.type) {
    case 'rows.toggle':
      // Only a result with rows has rows to show (or the agent's, kept under a refused read).
      if (cardKind(state.query.purpose, shownOutcome(state)) !== 'rows' && !keptOutcome(state))
        return state
      // Closing is the card's chevron closing the card: the editor folds with the rows (the draft is kept and the
      // folded SQL says Edited), so the card goes back to its closed form, not to an editor with no rows under it.
      // Opening shows the rows and leaves the editor as it is.
      return state.rows === 'open'
        ? { ...state, rows: 'closed', pane: 'short' }
        : { ...state, rows: 'open' }
    case 'rows.close':
      return state.rows === 'closed' ? state : { ...state, rows: 'closed' }
    case 'fold':
      return state.rows === 'closed' && state.pane === 'short'
        ? state
        : { ...state, rows: 'closed', pane: 'short' }
    case 'pane.toggle':
      return { ...state, pane: state.pane === 'short' ? 'full' : 'short' }
    case 'draft.change':
      if (!state.editable || state.pane !== 'full') return state
      // A finished hand-off or host failure is about the old draft; editing clears it.
      return {
        ...state,
        draft: event.draft,
        run: isBusy(state.run) ? state.run : { status: 'idle' }
      }
    case 'submit': {
      if (!state.editable || isBusy(state.run)) return state
      const action = submitAction(state.draft)
      if (action.kind === 'none') return state
      // Each runs only where the host can do it; a write the chat already has (or may) isn't sent again.
      if (action.kind === 'run' && !state.can.run) return state
      if (action.kind === 'send' && (!state.can.send || isHandedOff(state.run))) return state
      const id = state.nextId
      const run: Run =
        action.kind === 'run'
          ? { status: 'running', id, sql: state.draft }
          : { status: 'sending', id, sql: state.draft }
      return { ...state, run, nextId: id + 1 }
    }
    case 'run.done': {
      if (state.run.status !== 'running' || state.run.id !== event.id) return state
      const sql = state.run.sql
      const shown: Shown = { source: 'rerun', sql, outcome: event.outcome, readAt: event.at }
      const hasRows = event.outcome.status === 'rows' && event.outcome.rows.length > 0
      const fresh = {
        ...state,
        shown,
        run: { status: 'idle' },
        sort: null,
        page: 0,
        held: null,
        fetch: { status: 'idle' }
      } as const
      if (event.outcome.status === 'failed') {
        // The user is fixing it: the editor stays open on the error, over the agent's rows (dimmed) if they were open.
        const failed: CardState = { ...fresh, pane: 'full', found: { kind: 'failed' } }
        return { ...failed, rows: keptOutcome(failed) ? state.rows : 'closed' }
      }
      if (sql === state.query.sql)
        // The agent's SQL read again is a refresh: the editor had nothing to say, so it folds back to the tray and the
        // rows open on what the read found, compared with what was on screen.
        return {
          ...fresh,
          pane: 'short',
          rows: hasRows ? 'open' : 'closed',
          found: compareOutcomes(shownOutcome(state), event.outcome)
        }
      // The user's SQL: the editor stays open (they are iterating), the rows open on the answer.
      return { ...fresh, rows: hasRows ? 'open' : 'closed', found: { kind: 'edited' } }
    }
    case 'run.error':
      if (state.run.status !== 'running' || state.run.id !== event.id) return state
      return { ...state, run: { status: 'failed', error: event.error } }
    case 'send.done':
      // A confirmation after the view stopped waiting still lands.
      if (
        (state.run.status !== 'sending' && state.run.status !== 'unconfirmed') ||
        state.run.id !== event.id
      )
        return state
      return { ...state, run: { status: 'sent', sql: state.run.sql } }
    case 'send.error':
      if (
        (state.run.status !== 'sending' && state.run.status !== 'unconfirmed') ||
        state.run.id !== event.id
      )
        return state
      return { ...state, run: { status: 'refused', sql: state.run.sql } }
    case 'send.timeout':
      if (state.run.status !== 'sending' || state.run.id !== event.id) return state
      return { ...state, run: { status: 'unconfirmed', id: event.id, sql: state.run.sql } }
    case 'offset': {
      if (!limitPaging(state) || event.offset < 0) return state
      return cardReducer(state, { type: 'run.sql', sql: withOffset(shownSql(state), event.offset) })
    }
    case 'run.sql': {
      if (!state.can.run || isBusy(state.run) || verdictOf(event.sql).kind !== 'read') return state
      const id = state.nextId
      return {
        ...state,
        draft: event.sql,
        run: { status: 'running', id, sql: event.sql },
        nextId: id + 1
      }
    }
    case 'revert': {
      // A write on its way to the chat can't be called back: the card waits to say whether it got there.
      if (state.run.status === 'sending') return state
      return {
        ...initialCard(state.query, state.can, state.agentReadAt),
        pageSize: state.pageSize,
        nextId: state.nextId,
        pane: state.pane,
        rows: cardKind(state.query.purpose, state.query.outcome) === 'rows' ? state.rows : 'closed'
      }
    }
    case 'sort': {
      const outcome = shownOutcome(state)
      if (outcome.status !== 'rows') return state
      // From the order on its way, if one is: a second click while D1 sorts goes on from the first.
      const { fetch } = state
      const sort = nextSort(fetch.status === 'sorting' ? fetch.sort : state.sort, event.column)
      // The page stays (as in the dashboard's Studio): the same place in the new order.
      const page = isBusyFetch(fetch) ? fetch.page : state.page
      // Ranking only the rows held would mislead: D1 sorts the whole result. The page on screen stays until it lands.
      if (isPartial(outcome)) return sortingAt(state, sort, page)
      return { ...state, sort, page, fetch: { status: 'idle' } }
    }
    case 'page': {
      if (event.page < 0 || event.page >= pageCount(state)) return state
      // While D1 sorts, the page asked is the one the new order lands on.
      if (state.fetch.status === 'sorting') {
        const { fetch } = state
        return blockOf(state, event.page) === fetch.offset
          ? { ...state, fetch: { ...fetch, page: event.page } }
          : sortingAt(state, fetch.sort, event.page)
      }
      const missing = missingBlock(state, event.page)
      // A page that is held shows at once; one in flight is dropped (back while the next rows are read).
      if (missing === undefined) return { ...state, page: event.page, fetch: { status: 'idle' } }
      // A page in the block already on its way waits for it; any other replaces the read (its reply is then ignored).
      if (state.fetch.status === 'paging' && state.fetch.offset === missing * MAX_ROWS)
        return { ...state, fetch: { ...state.fetch, page: event.page } }
      const id = state.nextId
      return {
        ...state,
        fetch: { status: 'paging', id, page: event.page, offset: missing * MAX_ROWS },
        nextId: id + 1
      }
    }
    case 'fetch.done': {
      const { fetch } = state
      if (!isBusyFetch(fetch) || fetch.id !== event.id) return state
      if (fetch.status === 'sorting')
        return {
          ...state,
          held: new Map([[fetch.offset / MAX_ROWS, event.rows]]),
          sort: fetch.sort,
          page: fetch.page,
          fetch: { status: 'idle' }
        }
      const held = new Map(heldBlocks(state))
      held.set(fetch.offset / MAX_ROWS, event.rows)
      return { ...state, held, page: fetch.page, fetch: { status: 'idle' } }
    }
    case 'reread':
      // Like the agent's SQL run again here (run.done), but nothing of the card's own run changes.
      return {
        ...state,
        shown: { source: 'rerun', sql: state.query.sql, outcome: event.outcome, readAt: event.at },
        found: compareOutcomes(shownOutcome(state), event.outcome),
        sort: null,
        page: 0,
        held: null,
        fetch: { status: 'idle' }
      }
    case 'fetch.error': {
      const { fetch } = state
      if (!isBusyFetch(fetch) || fetch.id !== event.id) return state
      return { ...state, fetch: { status: 'failed', error: event.error } }
    }
  }
}

// ── Copy feedback ──

/**
 * - `idle`: every segment shows its label.
 * - `copied`: one segment shows its check until `reset`.
 * - `blocked`: the host's sandbox refused the clipboard.
 */
export type CopyFormat = 'markdown' | 'csv' | 'json'
export type CopyState =
  | { readonly status: 'idle' }
  | { readonly status: 'copied'; readonly format: CopyFormat; readonly at: number }
  | { readonly status: 'blocked'; readonly format: CopyFormat; readonly at: number }

export type CopyEvent =
  | { readonly type: 'copied'; readonly format: CopyFormat; readonly at: number }
  | { readonly type: 'blocked'; readonly format: CopyFormat; readonly at: number }
  /** The feedback's time is up. Only the feedback it was set for clears. */
  | { readonly type: 'reset'; readonly at: number }

export function copyReducer(state: CopyState, event: CopyEvent): CopyState {
  switch (event.type) {
    case 'copied':
    case 'blocked':
      return { status: event.type, format: event.format, at: event.at }
    case 'reset':
      return state.status !== 'idle' && state.at === event.at ? { status: 'idle' } : state
  }
}

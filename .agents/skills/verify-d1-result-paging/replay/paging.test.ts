/**
 * Replays the model's paths (model/D1ResultPaging.tla) against the real,
 * pure `cardReducer`, `heldBlocks`, `pageRows` and `heldIsContiguous` in
 * src/d1-studio/app/machines.ts, one reducer event per model action.
 *
 * The model's `TheReadStarts` is useFetchEffects in d1-studio-app.tsx
 * calling readSlice(shownSql(state), { sort, offset }); here the test plays
 * it by reading `shownSql(state)`, `state.sort` and `state.fetch` at that
 * moment, and answers with rows tagged "<sql>|<sort>|<row index>", which is
 * what `readSlice` returns for that SQL, sort and offset (`sliceSql` in run.ts).
 *
 * Set MACHINES_PATH to run the same replays against a scratch copy of machines.ts.
 *
 * Run: bun test .agents/skills/verify-d1-result-paging/replay
 */
import { describe, expect, test } from 'bun:test'
import type { D1Outcome, D1Query } from '../../../../src/d1-studio/contract'
import type * as Machines from '../../../../src/d1-studio/app/machines'

const path = process.env.MACHINES_PATH ?? '../../../../src/d1-studio/app/machines'
const m: typeof Machines = await import(path)
type CardState = Machines.CardState
type CardEvent = Machines.CardEvent
type Sort = Machines.Sort

const MAX_ROWS = 200
const AGENT = 'SELECT name, n FROM t'
const USER = 'SELECT name, n FROM t WHERE n > 0'

const sortWord = (s: Sort) => (s ? `${s.column}${s.dir}` : 'none')
/** Rows `from`..`from+n-1` of `sql`'s result in `sort`'s order, as readSlice returns them. */
const rowsOf = (sql: string, sort: Sort, from: number, n: number) =>
  Array.from({ length: n }, (_, i) => [`${sql}|${sortWord(sort)}|${from + i}`, from + i])

const outcome = (sql: string, total: number): D1Outcome => ({
  status: 'rows',
  columns: ['name', 'n'],
  rows: rowsOf(sql, null, 0, Math.min(total, MAX_ROWS)),
  rowCount: total,
  meta: { durationMs: 1, rowsRead: 1, rowsWritten: 0 }
})
const query = (total: number): D1Query => ({
  purpose: 'query',
  title: 'Top',
  sql: AGENT,
  outcome: outcome(AGENT, total)
})
/** The agent's card, partial (1,284 rows, 200 held), open; pageSize 100 is the console's, 10 the card's. */
const card = (pageSize: number): CardState => ({
  ...m.initialCard(query(1_284), true, 1_000),
  rows: 'open',
  pageSize
})
const run = (s: CardState, ...events: CardEvent[]) => events.reduce(m.cardReducer, s)

/** TheReadStarts: what useFetchEffects passes to readSlice, read off the state when it starts. */
function readStarts(s: CardState) {
  const f = s.fetch
  if (f.status !== 'paging' && f.status !== 'sorting') throw new Error('no read to start')
  const sort = f.status === 'sorting' ? f.sort : s.sort
  const offset = f.offset // useFetchEffects: { sort: fetch.sort, offset: fetch.offset } when sorting
  return { id: f.id, rows: rowsOf(m.shownSql(s), sort, offset, MAX_ROWS) }
}

/** RowsOnScreenMatchHeader: each row of the page is the row at its place in shownSql's result in state.sort order. */
function screenMatchesHeader(s: CardState): boolean {
  const from = s.page * s.pageSize
  return m
    .pageRows(s, s.page)
    .every((row, i) => row[0] === `${m.shownSql(s)}|${sortWord(s.sort)}|${from + i}`)
}

describe('PageIsTheOneAsked while a page loads: holds (paging-refuses)', () => {
  test('the old path: go to page 3, go to page 4 while page 3 loads, the rows land on page 4', () => {
    // Console, 100 rows a page: pages 3 and 4 (0-based 2 and 3) are both in block 1 (rows 201–400).
    let s = card(100)
    s = run(s, { type: 'page', page: 2 }) // 1. you go to page 3 (Go to row 201)
    expect(s.fetch).toMatchObject({ status: 'paging', page: 2, offset: 200 })
    const id = (s.fetch as { id: number }).id
    s = run(s, { type: 'page', page: 3 }) // 2. you go to page 4 (Go to row 301) while page 3 loads
    expect(s.fetch).toMatchObject({ status: 'paging', id, page: 3, offset: 200 }) // same read, waits for it
    const read = readStarts(s) // 3. the read goes to D1
    s = run(s, { type: 'fetch.done', id: read.id, rows: read.rows }) // 4. the rows land
    expect(s.page).toBe(3)
    expect(screenMatchesHeader(s)).toBe(true)
  })

  test('the card, 10 rows a page: rows 201–210, then rows 391–400 while they load, lands on 391–400', () => {
    let s = card(10)
    s = run(s, { type: 'page', page: 20 })
    const read = readStarts(s)
    s = run(s, { type: 'page', page: 39 }, { type: 'fetch.done', id: read.id, rows: read.rows })
    expect(s.page).toBe(39)
  })

  test('a page in another block replaces the read; the old reply is ignored', () => {
    let s = run(card(100), { type: 'page', page: 2 }) // block 1
    const old = readStarts(s)
    s = run(s, { type: 'page', page: 4 }) // block 2: a new read, new id
    expect(s.fetch).toMatchObject({ status: 'paging', page: 4, offset: 400 })
    expect((s.fetch as { id: number }).id).not.toBe(old.id)
    const read = readStarts(s)
    s = run(s, { type: 'fetch.done', id: old.id, rows: old.rows }) // the old reply lands late
    expect(s.fetch.status).toBe('paging')
    expect(s.page).toBe(0)
    s = run(s, { type: 'fetch.done', id: read.id, rows: read.rows })
    expect(s.page).toBe(4)
    expect(screenMatchesHeader(s)).toBe(true)
    expect([...m.heldBlocks(s).keys()]).toEqual([0, 2])
  })
})

describe('PageIsTheOneAsked while D1 sorts: holds (sort and page combine, as in the dashboard)', () => {
  test('the old finding: go to page 6 while D1 sorts, the sort lands on page 6 (sort-refuses-page)', () => {
    let s = run(card(100), { type: 'sort', column: 1 }) // 1. you click the column header
    expect(s.fetch).toMatchObject({ status: 'sorting', page: 0, offset: 0 })
    s = run(s, { type: 'page', page: 5 }) // 2. Go to row 501 while D1 sorts: block 2, a new sorted read
    expect(s.fetch).toMatchObject({ status: 'sorting', page: 5, offset: 400, sort: { column: 1, dir: 'asc' } })
    const read = readStarts(s) // 3. the read goes to D1
    s = run(s, { type: 'fetch.done', id: read.id, rows: read.rows }) // 4. the rows land
    expect(s.page).toBe(5)
    expect(s.sort).toEqual({ column: 1, dir: 'asc' })
    expect(screenMatchesHeader(s)).toBe(true)
    expect([...m.heldBlocks(s).keys()]).toEqual([2])
    expect(m.heldIsContiguous(s)).toBe(false)
  })

  test('a page in the block being sorted keeps the same read', () => {
    let s = run(card(100), { type: 'sort', column: 1 })
    const id = (s.fetch as { id: number }).id
    s = run(s, { type: 'page', page: 1 }) // same block 0
    expect(s.fetch).toMatchObject({ status: 'sorting', id, page: 1, offset: 0 })
    const read = readStarts(s)
    s = run(s, { type: 'fetch.done', id: read.id, rows: read.rows })
    expect(s.page).toBe(1)
    expect(screenMatchesHeader(s)).toBe(true)
  })

  test('a second header click while D1 sorts goes on from the first; the first reply is ignored', () => {
    let s = run(card(100), { type: 'sort', column: 1 })
    const first = readStarts(s)
    s = run(s, { type: 'sort', column: 1 }) // asc on its way, so desc
    expect(s.fetch).toMatchObject({ status: 'sorting', sort: { column: 1, dir: 'desc' } })
    const second = readStarts(s)
    s = run(s, { type: 'fetch.done', id: first.id, rows: first.rows })
    expect(s.fetch.status).toBe('sorting')
    s = run(s, { type: 'fetch.done', id: second.id, rows: second.rows })
    expect(s.sort).toEqual({ column: 1, dir: 'desc' })
    expect(screenMatchesHeader(s)).toBe(true)
  })

  test('a sort replaces a page read in flight and lands on that page', () => {
    let s = run(card(100), { type: 'page', page: 2 }) // block 1 loading
    const paging = readStarts(s)
    s = run(s, { type: 'sort', column: 1 })
    expect(s.fetch).toMatchObject({ status: 'sorting', page: 2, offset: 200 })
    const sorting = readStarts(s)
    s = run(s, { type: 'fetch.done', id: paging.id, rows: paging.rows }) // late, ignored
    expect(s.fetch.status).toBe('sorting')
    s = run(s, { type: 'fetch.done', id: sorting.id, rows: sorting.rows })
    expect(s.page).toBe(2)
    expect(screenMatchesHeader(s)).toBe(true)
    expect([...m.heldBlocks(s).keys()]).toEqual([1])
  })

  test('a whole result sorts in the view and keeps the page', () => {
    let s: CardState = { ...m.initialCard({ ...query(30), outcome: outcome(AGENT, 30) }, true, 1_000), pageSize: 10 }
    s = run(s, { type: 'page', page: 2 }, { type: 'sort', column: 1 })
    expect(s.page).toBe(2)
    expect(s.fetch.status).toBe('idle')
  })
})

describe('the rules that hold, on the paths their broken variants break', () => {
  test('RowsOnScreenMatchHeader: a run lands while a page loads; the late page is ignored (run-keeps-fetch)', () => {
    let s = run(card(100), { type: 'page', page: 2 }) // you go to page 3
    const read = readStarts(s) // the read goes to D1, for the agent's SQL
    s = run(s, { type: 'run.sql', sql: USER }) // you run your SQL
    const id = s.run.status === 'running' ? s.run.id : -1
    s = run(s, { type: 'run.done', id, outcome: outcome(USER, 1_284), at: 2_000 }) // your run lands
    s = run(s, { type: 'fetch.done', id: read.id, rows: read.rows }) // the old page's rows land
    expect(m.shownSql(s)).toBe(USER)
    expect(screenMatchesHeader(s)).toBe(true)
    expect(s.page).toBe(0)
    expect([...m.heldBlocks(s).keys()]).toEqual([0])
    // Going to page 3 of the user's result reads it for the user's SQL.
    s = run(s, { type: 'page', page: 2 })
    const next = readStarts(s)
    s = run(s, { type: 'fetch.done', id: next.id, rows: next.rows })
    expect(screenMatchesHeader(s)).toBe(true)
  })

  test('RowsOnScreenMatchHeader: a D1 sort replaces the blocks read in the old order (sorted-keeps-blocks)', () => {
    let s = run(card(100), { type: 'page', page: 2 })
    let read = readStarts(s)
    s = run(s, { type: 'fetch.done', id: read.id, rows: read.rows })
    expect([...m.heldBlocks(s).keys()]).toEqual([0, 1])
    s = run(s, { type: 'sort', column: 1 }) // the page stays: block 1, in the new order
    read = readStarts(s)
    s = run(s, { type: 'fetch.done', id: read.id, rows: read.rows })
    expect([...m.heldBlocks(s).keys()]).toEqual([1])
    expect(screenMatchesHeader(s)).toBe(true)
    s = run(s, { type: 'page', page: 0 }) // block 0 again: read in the new order
    read = readStarts(s)
    s = run(s, { type: 'fetch.done', id: read.id, rows: read.rows })
    expect(screenMatchesHeader(s)).toBe(true)
  })

  test('ReadCanLand: a D1 sort that fails leaves the card, not loading (error-ignores-sort)', () => {
    let s = run(card(100), { type: 'sort', column: 1 })
    const id = s.fetch.status === 'sorting' ? s.fetch.id : -1
    s = run(s, { type: 'fetch.error', id, error: 'D1 refused it' })
    expect(s.fetch).toEqual({ status: 'failed', error: 'D1 refused it' })
  })

  test('CopyFirstNIsTrue: a jump past an unread block is not "the first N" (contiguous-off-by-one)', () => {
    let s = run(card(100), { type: 'page', page: 4 }) // block 2: rows 401–600
    const read = readStarts(s)
    s = run(s, { type: 'fetch.done', id: read.id, rows: read.rows })
    expect([...m.heldBlocks(s).keys()]).toEqual([0, 2])
    expect(m.heldIsContiguous(s)).toBe(false)
  })
})

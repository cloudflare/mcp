import { describe, expect, it } from 'vitest'
import type { D1Outcome, D1Query } from '../src/d1-studio/contract'
import { fitColumns, serializeRows } from '../src/d1-studio/app/format'
import {
  CONSOLE_PAGE_ROWS,
  PAGE_ROWS,
  ageWords,
  canRevert,
  cardKind,
  cardReducer,
  compareOutcomes,
  copyReducer,
  foundWords,
  heldRows,
  initialCard,
  isStale,
  isEdited,
  keptOutcome,
  limitPaging,
  heldIsContiguous,
  nextSort,
  pageCount,
  pageRows,
  shownOutcome,
  shownSql,
  sortRows,
  type CardEvent,
  type CardState
} from '../src/d1-studio/app/machines'
import { foldSql, wrapOnlyAtClauses } from '../src/d1-studio/app/sql-fold'
import { sliceSql } from '../src/d1-studio/app/run'
import { rawOutcome } from '../src/d1-studio/raw'
import {
  classifyStatement,
  cleanD1Error,
  closest,
  errorToken,
  hasIdentifier,
  replaceIdentifier
} from '../src/d1-studio/statement'
import { tablesIn } from '../src/d1-studio/read'
import {
  fixOf,
  limitOf,
  markOf,
  reasonOf,
  verdictOf,
  withOffset
} from '../src/d1-studio/app/verdict'

const rows = (r: (string | number | null)[][]): D1Outcome => ({
  status: 'rows',
  columns: ['name', 'n'],
  rows: r,
  rowCount: r.length,
  meta: { durationMs: 1.5, rowsRead: 10, rowsWritten: 0 }
})
const query = (outcome: D1Outcome, purpose: D1Query['purpose'] = 'query'): D1Query => ({
  purpose,
  title: 'Top',
  sql: 'SELECT name, n FROM t LIMIT 10',
  outcome
})
const run = (state: CardState, ...events: CardEvent[]) => events.reduce(cardReducer, state)

describe('classifyStatement', () => {
  it.each([
    'SELECT 1',
    'select * from t;',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    'EXPLAIN QUERY PLAN SELECT * FROM t',
    'VALUES (1), (2)',
    'PRAGMA table_info(appointments)',
    "SELECT replace(name, 'a', 'b') FROM t",
    "SELECT 'DELETE FROM t; DROP TABLE x' AS s",
    'SELECT "update" FROM t -- delete everything\n',
    'SELECT 1 /* ; DROP TABLE t */',
    "SELECT SUM(CASE WHEN status = 'no_show' THEN price END) AS lost FROM t"
  ])('reads: %s', (sql) => {
    expect(classifyStatement(sql)).toEqual({ kind: 'read' })
  })

  it.each([
    ['DELETE FROM t', 'DELETE'],
    ['WITH x AS (SELECT 1) DELETE FROM t', 'DELETE'],
    ['INSERT INTO t VALUES (1)', 'INSERT'],
    ['REPLACE INTO t VALUES (1)', 'REPLACE'],
    // A replace() function earlier in the text doesn't vouch for a later REPLACE INTO.
    [
      "WITH x AS (SELECT replace(name,'a','b') AS n FROM t) REPLACE INTO t2(n) SELECT n FROM x",
      'REPLACE'
    ],
    ['CREATE INDEX i ON t(a)', 'CREATE'],
    ['PRAGMA foreign_keys = OFF', 'PRAGMA'],
    ['PRAGMA journal_mode', 'PRAGMA'],
    ['BEGIN', 'BEGIN'],
    ['END TRANSACTION', 'END'],
    ['ATTACH DATABASE x AS y', 'ATTACH']
  ])('writes: %s', (sql, keyword) => {
    expect(classifyStatement(sql)).toEqual({ kind: 'write', keyword })
  })

  it('refuses more than one statement, and an empty text', () => {
    expect(classifyStatement('SELECT 1; SELECT 2')).toEqual({ kind: 'multiple' })
    expect(classifyStatement('  ;  -- nothing')).toEqual({ kind: 'empty' })
  })
})

describe('replaceIdentifier', () => {
  it('replaces whole identifiers only, never inside a longer name, a string or a comment', () => {
    const sql = "SELECT nam, surname FROM users WHERE note = 'nam' -- nam\n AND u.nam > 1"
    expect(replaceIdentifier(sql, 'nam', 'name')).toBe(
      "SELECT name, surname FROM users WHERE note = 'nam' -- nam\n AND u.name > 1"
    )
    expect(replaceIdentifier('SELECT a.start_at FROM a', 'a.start_at', 'a.starts_at')).toBe(
      'SELECT a.starts_at FROM a'
    )
    expect(hasIdentifier("SELECT surname FROM t WHERE x = 'nam'", 'nam')).toBe(false)
  })
})

describe('D1 errors', () => {
  it('cleans the wrapper and finds the identifier', () => {
    const error = cleanD1Error('D1_ERROR: no such column: a.start_at: SQLITE_ERROR')
    expect(error).toBe('no such column: a.start_at')
    expect(errorToken(error)).toBe('a.start_at')
  })

  it('reads a raw body into an outcome, capping rows and counting them', () => {
    const body = {
      success: true,
      result: [
        {
          results: { columns: ['a', 'o'], rows: [...Array(250)].map((_, i) => [i, { x: 1 }]) },
          meta: { duration: 2, rows_read: 250, timings: { sql_duration_ms: 1.25 } }
        }
      ]
    }
    const outcome = rawOutcome(200, body)
    expect(outcome).toMatchObject({ status: 'rows', columns: ['a', 'o'], rowCount: 250 })
    if (outcome.status !== 'rows') throw new Error('expected rows')
    expect(outcome.rows).toHaveLength(200)
    expect(outcome.rows[0]).toEqual([0, '{"x":1}'])
    expect(outcome.meta).toEqual({ durationMs: 1.25, rowsRead: 250, rowsWritten: null })
  })

  it('reads a failed raw body', () => {
    expect(
      rawOutcome(400, {
        success: false,
        errors: [{ code: 7500, message: 'no such table: nope: SQLITE_ERROR' }]
      })
    ).toEqual({ status: 'failed', error: 'no such table: nope', token: 'nope' })
  })
})

describe('cardKind', () => {
  it('derives every kind from the outcome and purpose', () => {
    expect(cardKind('query', null)).toBe('running')
    expect(cardKind('query', rows([['a', 1]]))).toBe('rows')
    expect(cardKind('query', rows([]))).toBe('none')
    expect(cardKind('tables', rows([]))).toBe('empty-db')
    expect(cardKind('query', { status: 'failed', error: 'x' })).toBe('error')
  })
})

describe('card machine', () => {
  const start = () =>
    initialCard(
      query(
        rows([
          ['b', 2],
          ['a', 1]
        ])
      ),
      true
    )

  it('opens rows only when there are rows', () => {
    expect(run(start(), { type: 'rows.toggle' }).rows).toBe('open')
    const empty = initialCard(query(rows([])), true)
    expect(run(empty, { type: 'rows.toggle' }).rows).toBe('closed')
  })

  it('folds the editor when the chevron closes the rows, keeping the draft', () => {
    const draft = 'SELECT name FROM t'
    const open = run(
      start(),
      { type: 'rows.toggle' },
      { type: 'pane.toggle' },
      { type: 'draft.change', draft }
    )
    expect(open.pane).toBe('full')

    const closed = run(open, { type: 'rows.toggle' })

    expect(closed.rows).toBe('closed')
    expect(closed.pane).toBe('short')
    expect(closed.draft).toBe(draft)
  })

  it('leaves the editor open when the chevron opens the rows', () => {
    const s = run(start(), { type: 'pane.toggle' }, { type: 'rows.toggle' })

    expect(s.rows).toBe('open')
    expect(s.pane).toBe('full')
  })

  it('edits only in the open pane of an editable card', () => {
    expect(run(start(), { type: 'draft.change', draft: 'x' }).draft).toBe(start().draft)
    const readOnly = initialCard(query(rows([])), false)
    expect(run(readOnly, { type: 'pane.toggle' }, { type: 'draft.change', draft: 'x' }).draft).toBe(
      readOnly.draft
    )
    expect(
      run(start(), { type: 'pane.toggle' }, { type: 'draft.change', draft: 'SELECT 2' }).draft
    ).toBe('SELECT 2')
  })

  it('runs a read, lays the result over the agent’s, and opens the rows', () => {
    let s = run(start(), { type: 'pane.toggle' }, { type: 'draft.change', draft: 'SELECT 9 AS n' })
    s = run(s, { type: 'sort', column: 0 }, { type: 'submit' })
    expect(s.run).toEqual({ status: 'running', id: 1, sql: 'SELECT 9 AS n' })
    // A second submit while running does nothing.
    expect(run(s, { type: 'submit' })).toBe(s)
    s = run(s, { type: 'run.done', id: 1, outcome: rows([['z', 9]]), at: 0 })
    expect(s.run).toEqual({ status: 'idle' })
    expect(s.rows).toBe('open')
    expect(s.sort).toBeNull()
    expect(shownSql(s)).toBe('SELECT 9 AS n')
    expect(shownOutcome(s)).toEqual(rows([['z', 9]]))
    expect(isEdited(s)).toBe(true)
    // The agent's query is never changed.
    expect(s.query.sql).toBe('SELECT name, n FROM t LIMIT 10')
  })

  it('ignores a reply to a run the user reverted', () => {
    let s = run(
      start(),
      { type: 'pane.toggle' },
      { type: 'draft.change', draft: 'SELECT 1' },
      { type: 'submit' }
    )
    s = run(s, { type: 'revert' })
    expect(s.run).toEqual({ status: 'idle' })
    expect(isEdited(s)).toBe(false)
    expect(run(s, { type: 'run.done', id: 1, outcome: rows([]), at: 0 })).toBe(s)
    expect(run(s, { type: 'run.error', id: 1, error: 'late' })).toBe(s)
  })

  it('ignores a reply to an older run', () => {
    let s = run(start(), { type: 'pane.toggle' }, { type: 'submit' })
    s = run(s, { type: 'run.error', id: 1, error: 'host down' })
    expect(s.run).toEqual({ status: 'failed', error: 'host down' })
    s = run(s, { type: 'submit' })
    expect(s.run).toMatchObject({ status: 'running', id: 2 })
    expect(run(s, { type: 'run.done', id: 1, outcome: rows([]), at: 0 })).toBe(s)
  })

  it('hands a write to the chat instead of running it', () => {
    let s = run(
      start(),
      { type: 'pane.toggle' },
      { type: 'draft.change', draft: 'DELETE FROM t' },
      { type: 'submit' }
    )
    expect(s.run).toEqual({ status: 'sending', id: 1, sql: 'DELETE FROM t' })
    expect(run(s, { type: 'run.done', id: 1, outcome: rows([]), at: 0 })).toBe(s)
    s = run(s, { type: 'send.done', id: 1 })
    expect(s.run).toEqual({ status: 'sent', sql: 'DELETE FROM t' })
    expect(shownOutcome(s)).toBe(s.query.outcome)
    // Editing again clears the hand-off.
    expect(run(s, { type: 'draft.change', draft: 'SELECT 1' }).run).toEqual({ status: 'idle' })
  })

  it('does nothing for an empty draft', () => {
    const s = run(start(), { type: 'pane.toggle' }, { type: 'draft.change', draft: '  ' })
    expect(run(s, { type: 'submit' })).toBe(s)
  })

  it('sorts ascending, descending, then back', () => {
    expect(nextSort(null, 1)).toEqual({ column: 1, dir: 'asc' })
    expect(nextSort({ column: 1, dir: 'asc' }, 1)).toEqual({ column: 1, dir: 'desc' })
    expect(nextSort({ column: 1, dir: 'desc' }, 1)).toBeNull()
    expect(nextSort({ column: 1, dir: 'desc' }, 0)).toEqual({ column: 0, dir: 'asc' })
    const r = [
      ['b', 2],
      ['a', null],
      ['c', 10]
    ]
    expect(sortRows(r, { column: 1, dir: 'asc' }).map((x) => x[0])).toEqual(['b', 'c', 'a'])
    expect(sortRows(r, { column: 1, dir: 'desc' }).map((x) => x[0])).toEqual(['c', 'b', 'a'])
    expect(sortRows(r, null)).toBe(r)
  })
})

describe('refresh, paging and D1 sort', () => {
  const sql = 'SELECT name, n FROM t'
  const many = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => [`r${from + i}`, from + i] as (string | number)[])
  const capped = (held: number, total: number): D1Outcome => ({
    status: 'rows',
    columns: ['name', 'n'],
    rows: many(held),
    rowCount: total,
    meta: { durationMs: 1.5, rowsRead: 10, rowsWritten: 0 }
  })
  const card = (outcome: D1Outcome) => initialCard({ ...query(outcome), sql }, true, 1_000)

  it('re-reads the agent’s SQL as a refresh: editor folds, rows open, changes found', () => {
    let s = run(
      card(
        rows([
          ['a', 1],
          ['b', 2]
        ])
      ),
      { type: 'pane.toggle' },
      { type: 'submit' }
    )
    s = run(s, {
      type: 'run.done',
      id: 1,
      outcome: rows([
        ['a', 1],
        ['b', 3]
      ]),
      at: 5_000
    })
    expect(s.pane).toBe('short')
    expect(s.rows).toBe('open')
    expect(foundWords(s.found)).toBe('1 value changed')
    const after = shownOutcome(s)
    expect(
      after.status === 'rows' &&
        s.found.kind === 'changed' &&
        s.found.was.get(after.rows[1]!)?.get(1)
    ).toBe(2)
    // Nothing to revert: the SQL is the agent's.
    expect(canRevert(s)).toBe(false)
    expect(s.shown.readAt).toBe(5_000)
  })

  it('says no change when nothing moved, and keeps the editor open on the user’s SQL', () => {
    let s = run(card(rows([['a', 1]])), { type: 'pane.toggle' }, { type: 'submit' })
    s = run(s, { type: 'run.done', id: 1, outcome: rows([['a', 1]]), at: 2 })
    expect(foundWords(s.found)).toBe('no change')
    s = run(
      s,
      { type: 'pane.toggle' },
      { type: 'draft.change', draft: 'SELECT 1' },
      { type: 'submit' }
    )
    s = run(s, { type: 'run.done', id: 2, outcome: rows([['x', 1]]), at: 3 })
    expect(s.pane).toBe('full')
    expect(s.found).toEqual({ kind: 'edited' })
    expect(canRevert(s)).toBe(true)
    s = run(s, { type: 'revert' })
    expect(s.found).toEqual({ kind: 'agent' })
    expect(s.shown.readAt).toBe(1_000)
  })

  it('counts rows when a re-read changes how many there are', () => {
    expect(
      compareOutcomes(
        rows([['a', 1]]),
        rows([
          ['a', 1],
          ['b', 2]
        ])
      )
    ).toEqual({
      kind: 'count',
      before: 1,
      after: 2
    })
  })

  it('is stale after ten minutes, and words the age', () => {
    const s = card(rows([['a', 1]]))
    expect(isStale(s, 1_000 + 9 * 60_000)).toBe(false)
    expect(isStale(s, 1_000 + 10 * 60_000)).toBe(true)
    expect(ageWords(3 * 3_600_000, Date.now())).toBe('3h ago')
    expect(ageWords(30 * 3_600_000, Date.now())).toBe('yesterday')
  })

  it('pages the rows held, then reads the next ones past them', () => {
    let s = run(card(capped(200, 1_284)), { type: 'rows.toggle' })
    s = run(s, { type: 'page', page: 1 })
    expect(s.page).toBe(1)
    expect(run(s, { type: 'page', page: -1 })).toBe(s)
    s = run(s, { type: 'page', page: 19 }, { type: 'page', page: 20 })
    expect(s.page).toBe(19)
    expect(s.fetch).toMatchObject({ status: 'paging', page: 20, offset: 200 })
    // Back while it reads: the read is dropped.
    expect(run(s, { type: 'page', page: 18 })).toMatchObject({
      page: 18,
      fetch: { status: 'idle' }
    })
    const id = (s.fetch as { id: number }).id
    s = run(s, { type: 'fetch.done', id, rows: many(200, 200) })
    expect(s.page).toBe(20)
    expect(heldRows(s)).toHaveLength(400)
    expect(heldRows(s)[200]![0]).toBe('r200')
    expect(PAGE_ROWS).toBe(10)
  })

  it('sorts a whole result in the view, and a partial one in D1, keeping the page', () => {
    // As in the dashboard's Studio: sorting keeps your place, the same page in the new order.
    let whole = run(card(rows(many(47))), { type: 'page', page: 3 }, { type: 'sort', column: 1 })
    expect(whole.page).toBe(3)
    whole = run(whole, { type: 'sort', column: 1 }, { type: 'page', page: 0 })
    expect(heldRows(whole)[0]![1]).toBe(46)

    let part = run(card(capped(200, 1_284)), { type: 'page', page: 2 }, { type: 'sort', column: 1 })
    expect(part.fetch).toMatchObject({
      status: 'sorting',
      sort: { column: 1, dir: 'asc' },
      page: 2,
      offset: 0
    })
    // A page asked while D1 sorts is the page the sort lands on: same block, same read.
    part = run(part, { type: 'page', page: 3 })
    expect(part.fetch).toMatchObject({ status: 'sorting', page: 3, offset: 0 })
    const id = (part.fetch as { id: number }).id
    part = run(part, { type: 'fetch.done', id, rows: many(200, 5) })
    expect(part).toMatchObject({
      page: 3,
      sort: { column: 1, dir: 'asc' },
      fetch: { status: 'idle' }
    })
    expect(heldRows(part)[0]![0]).toBe('r5')
  })

  it('reads the block a page asked during a D1 sort is in, in the new order; the old reply is ignored', () => {
    let s = run(card(capped(200, 1_284)), { type: 'sort', column: 1 })
    const first = (s.fetch as { id: number }).id
    // Row 501 is in the third block of 200.
    s = run(s, { type: 'page', page: 50 })
    expect(s.fetch).toMatchObject({ status: 'sorting', page: 50, offset: 400 })
    expect(run(s, { type: 'fetch.done', id: first, rows: many(200, 0) })).toBe(s)
    const id = (s.fetch as { id: number }).id
    s = run(s, { type: 'fetch.done', id, rows: many(200, 400) })
    expect(s).toMatchObject({ page: 50, sort: { column: 1, dir: 'asc' }, fetch: { status: 'idle' } })
    expect(pageRows(s, 50)[0]![0]).toBe('r500')
    expect(heldIsContiguous(s)).toBe(false)
  })

  it('a second header click while D1 sorts goes on from the order on its way', () => {
    let s = run(card(capped(200, 1_284)), { type: 'sort', column: 1 }, { type: 'sort', column: 1 })
    expect(s.fetch).toMatchObject({ status: 'sorting', sort: { column: 1, dir: 'desc' } })
  })

  it('wraps a read to slice and sort it in D1, and refuses what it can’t wrap', () => {
    expect(
      sliceSql('SELECT * FROM t;', { sort: { column: 1, dir: 'desc' }, limit: 200, offset: 400 })
    ).toBe('SELECT * FROM (\nSELECT * FROM t\n) ORDER BY 2 DESC NULLS LAST LIMIT 200 OFFSET 400')
    expect(sliceSql('PRAGMA table_list', { sort: null, limit: 200, offset: 0 })).toBeUndefined()
    // A comment after the final `;` doesn't stop the query being wrapped.
    expect(sliceSql('SELECT * FROM events; -- recent', { sort: null, limit: 200, offset: 0 })).toBe(
      'SELECT * FROM (\nSELECT * FROM events\n) LIMIT 200 OFFSET 0'
    )
  })
})

describe('copy machine', () => {
  it('clears only the feedback its timer was set for', () => {
    let s = copyReducer({ status: 'idle' }, { type: 'copied', format: 'csv', at: 1 })
    s = copyReducer(s, { type: 'copied', format: 'json', at: 2 })
    expect(copyReducer(s, { type: 'reset', at: 1 })).toBe(s)
    expect(copyReducer(s, { type: 'reset', at: 2 })).toEqual({ status: 'idle' })
  })
})

describe('copy formats', () => {
  const cols = ['name', 'n']
  const r = [
    ['a|b', 1],
    ['say "hi"', null]
  ]
  it('writes Markdown with numeric columns right-aligned', () => {
    expect(serializeRows('markdown', cols, r)).toBe(
      '| name | n |\n| --- | ---: |\n| a\\|b | 1 |\n| say "hi" | NULL |'
    )
  })
  it('writes CSV and JSON', () => {
    expect(serializeRows('csv', cols, r)).toBe('name,n\na|b,1\n"say ""hi""",')
    expect(JSON.parse(serializeRows('json', cols, r))).toEqual([
      { name: 'a|b', n: 1 },
      { name: 'say "hi"', n: null }
    ])
  })
})

describe('foldSql', () => {
  it('keeps a short query on one line and folds a long one a clause per line', () => {
    expect(foldSql('SELECT 1', 70)).toEqual({ lines: [[{ text: 'SELECT 1' }]], flow: false })
    const long = `SELECT a, b, c, d, e FROM t JOIN u ON u.id = t.u WHERE t.x > 1 GROUP BY a ORDER BY b DESC LIMIT 10`
    const folded = foldSql(long, 40)
    expect(folded.lines.length).toBeGreaterThan(2)
    expect(folded.lines.flat().some((tok) => 'fold' in tok)).toBe(true)
  })
  it('keeps room on the last line for the tray action, folding the last clause at its AND', () => {
    const sql = "SELECT a FROM t WHERE x >= '2026-10-01' AND x < '2026-11-01' AND status = 'open'"
    const folded = foldSql(sql, 50, 9, 'any')
    const last = folded.lines.at(-1)!
    expect(last).toEqual([{ text: "AND status = 'open'" }])
    expect(folded.cont).toEqual([folded.lines.length - 1])
    expect(folded.over).toBeUndefined()
  })
  it('says when nothing can make room, so the action takes its own line', () => {
    expect(foldSql('SELECT a FROM t ORDER BY a_long_column_name DESC', 30, 12, 'any').over).toBe(
      true
    )
  })
})

describe('wrapOnlyAtClauses', () => {
  it('lets a line wrap at clauses and commas, never inside a predicate or a function call', () => {
    const [tok] = wrapOnlyAtClauses([
      { text: "SELECT ROUND(AVG(x), 3) AS r, y WHERE a.status = 'no show' AND b > 1" }
    ])
    // Only ordinary spaces may wrap; every other space is a no-break space.
    const lines = (tok as { text: string }).text.split(' ')
    expect(lines).toEqual([
      'SELECT\u00a0ROUND(AVG(x),\u00a03)\u00a0AS\u00a0r,',
      'y',
      "WHERE\u00a0a.status\u00a0=\u00a0'no\u00a0show'",
      'AND\u00a0b\u00a0>\u00a01'
    ])
  })
})

describe('draft verdicts', () => {
  it('reads, empty', () => {
    expect(verdictOf('SELECT 1')).toEqual({ kind: 'read' })
    expect(verdictOf('  ')).toEqual({ kind: 'empty' })
  })

  it('marks text after the ; and offers to remove it', () => {
    const sql = 'SELECT * FROM t; thanks'
    const v = verdictOf(sql)
    expect(v).toMatchObject({ kind: 'tail', keep: 'SELECT * FROM t;' })
    expect(sql.slice(...markOf(v)!)).toBe('thanks')
    expect(fixOf(v, sql)).toEqual({ label: 'Remove it', sql: 'SELECT * FROM t;' })
    expect(reasonOf(v)).toMatch(/one statement/)
  })

  it('counts several statements and keeps the first', () => {
    const sql = 'SELECT 1; SELECT 2'
    const v = verdictOf(sql)
    expect(v).toMatchObject({ kind: 'multiple', count: 2 })
    expect(fixOf(v, sql)).toEqual({ label: 'Keep the first', sql: 'SELECT 1;' })
    expect(reasonOf(v)).toBe('Two statements. Run takes one at a time.')
  })

  it('suggests the statement a typo meant', () => {
    const sql = 'SELCT * FROM t'
    const v = verdictOf(sql)
    expect(v).toMatchObject({ kind: 'typo', word: 'SELCT', suggest: 'SELECT' })
    expect(fixOf(v, sql)?.sql).toBe('SELECT * FROM t')
  })

  it('hands a write to the chat, with no fix and no mark', () => {
    const v = verdictOf('DELETE FROM t WHERE id = 1')
    expect(v).toMatchObject({ kind: 'write', keyword: 'DELETE' })
    expect(fixOf(v, '')).toBeUndefined()
    expect(markOf(v)).toBeUndefined()
  })

  it('reads and rewrites a query’s own LIMIT and OFFSET', () => {
    expect(limitOf('SELECT * FROM t LIMIT 5')).toEqual({ limit: 5, offset: 0 })
    expect(limitOf("SELECT 'LIMIT 3' FROM t")).toEqual({ offset: 0 })
    expect(withOffset('SELECT * FROM t LIMIT 5;', 5)).toBe('SELECT * FROM t LIMIT 5 OFFSET 5;')
    expect(withOffset('SELECT * FROM t LIMIT 5 OFFSET 5', 0)).toBe('SELECT * FROM t LIMIT 5')
  })

  it('finds the close name and skips an exact one', () => {
    expect(closest('start_at', ['starts_at', 'ends_at'])).toBe('starts_at')
    expect(closest('starts_at', ['starts_at'])).toBeUndefined()
    expect(closest('zzz', ['starts_at'])).toBeUndefined()
  })

  it('finds the tables a query reads and their aliases', () => {
    expect(
      tablesIn('SELECT a.x FROM appointments a JOIN clients AS c ON c.id = a.c WHERE 1', [
        'appointments',
        'clients'
      ])
    ).toEqual([
      { table: 'appointments', alias: 'a' },
      { table: 'clients', alias: 'c' }
    ])
  })

  it('doesn’t take a join keyword for an alias', () => {
    expect(tablesIn('SELECT a.x FROM a RIGHT JOIN b ON b.id = a.b', ['a', 'b'])).toEqual([
      { table: 'a' },
      { table: 'b' }
    ])
    expect(tablesIn('SELECT * FROM a FULL OUTER JOIN b USING (id)', ['a', 'b'])).toEqual([
      { table: 'a' },
      { table: 'b' }
    ])
  })
})

describe('sends, refused reads and LIMIT paging', () => {
  const edit = (draft: string, outcome = rows([['a', 1]])) =>
    run(initialCard(query(outcome), true), { type: 'pane.toggle' }, { type: 'draft.change', draft })

  it('stops waiting for an unconfirmed send, and still takes a late answer', () => {
    let s = run(edit('DELETE FROM t'), { type: 'submit' })
    s = run(s, { type: 'send.timeout', id: 1 })
    expect(s.run).toEqual({ status: 'unconfirmed', id: 1, sql: 'DELETE FROM t' })
    expect(run(s, { type: 'send.done', id: 1 }).run).toEqual({
      status: 'sent',
      sql: 'DELETE FROM t'
    })
    expect(run(s, { type: 'send.error', id: 1, error: 'no' }).run).toEqual({
      status: 'refused',
      sql: 'DELETE FROM t'
    })
    // A timeout for a send that already landed changes nothing.
    const sent = run(s, { type: 'send.done', id: 1 })
    expect(run(sent, { type: 'send.timeout', id: 1 })).toBe(sent)
  })

  it('keeps the agent’s rows, dimmed, under a read D1 refused', () => {
    let s = run(edit('SELECT nope FROM t'), { type: 'rows.toggle' }, { type: 'submit' })
    s = run(s, {
      type: 'run.done',
      id: 1,
      outcome: { status: 'failed', error: 'no such column: nope', token: 'nope' },
      at: 1
    })
    expect(s.pane).toBe('full')
    expect(s.rows).toBe('open')
    expect(keptOutcome(s)).toBe(s.query.outcome)
  })

  it('runs only reads through run.sql', () => {
    const s = edit('SELECT 1')
    expect(run(s, { type: 'run.sql', sql: 'DROP TABLE t' })).toBe(s)
    expect(run(s, { type: 'run.sql', sql: 'SELECT 2' }).run).toEqual({
      status: 'running',
      id: 1,
      sql: 'SELECT 2'
    })
  })

  it('pages a small LIMIT by writing OFFSET into the SQL', () => {
    const full = rows(Array.from({ length: 5 }, (_, i) => [`r${i}`, i]))
    let s = initialCard({ ...query(full), sql: 'SELECT name, n FROM t LIMIT 5' }, true)
    expect(limitPaging(s)).toEqual({ limit: 5, offset: 0 })
    s = run(s, { type: 'offset', offset: 5 })
    expect(s.run).toMatchObject({
      status: 'running',
      sql: 'SELECT name, n FROM t LIMIT 5 OFFSET 5'
    })
    // A LIMIT that came back short of itself has nothing past it.
    const short = initialCard(
      { ...query(rows([['a', 1]])), sql: 'SELECT name, n FROM t LIMIT 5' },
      true
    )
    expect(limitPaging(short)).toBeUndefined()
  })
})

describe('console paging', () => {
  const capped = (total: number): D1Outcome => ({
    status: 'rows',
    columns: ['name', 'n'],
    rows: Array.from({ length: 200 }, (_, i) => [`r${i}`, i]),
    rowCount: total,
    meta: { durationMs: 1, rowsRead: 1, rowsWritten: 0 }
  })

  it('pages 100 rows at a time and reads the block a jump lands in', () => {
    let s: CardState = {
      ...initialCard({ ...query(capped(1_284)), sql: 'SELECT name, n FROM t' }, true),
      rows: 'open',
      pageSize: CONSOLE_PAGE_ROWS
    }
    expect(pageCount(s)).toBe(13)
    expect(pageRows(s, 1)[0]![0]).toBe('r100')
    s = run(s, { type: 'page', page: 10 })
    expect(s.fetch).toMatchObject({ status: 'paging', page: 10, offset: 1_000 })
    const id = (s.fetch as { id: number }).id
    s = run(s, {
      type: 'fetch.done',
      id,
      rows: Array.from({ length: 200 }, (_, i) => [`r${1_000 + i}`, 1_000 + i])
    })
    expect(s.page).toBe(10)
    expect(pageRows(s, 10)[0]![0]).toBe('r1000')
    // A hole between the first block and the one read: what is held is no longer "the first N".
    expect(heldIsContiguous(s)).toBe(false)
  })
})

describe('the inline card', () => {
  // Mono at 7 px: a column is max(name, widest value) characters, plus 16 px of padding.
  const cells = [
    { name: 7, cell: 20 }, // partner: 156 px, 100 as the flex column
    { name: 8, cell: 8 }, // location: 72 px
    { name: 6, cell: 3 }, // booked: 58 px
    { name: 8, cell: 2 } // no_shows: 72 px
  ]

  it('shows the columns that fit, the text column giving way first', () => {
    expect(fitColumns(cells, 7, 34 + 156 + 72 + 58 + 72, 34, 5, -1)).toBe(4)
    expect(fitColumns(cells, 7, 34 + 100 + 72 + 58, 34, 5, 0)).toBe(3)
    expect(fitColumns(cells, 7, 34 + 156 + 72 + 58, 34, 5, -1)).toBe(3)
  })

  it('keeps at most max columns, and always one', () => {
    expect(fitColumns(cells, 7, 10_000, 34, 2)).toBe(2)
    expect(fitColumns(cells, 7, 10, 34, 5)).toBe(1)
    expect(fitColumns([], 7, 500, 34, 5)).toBe(0)
  })
})

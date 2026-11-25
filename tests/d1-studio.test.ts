import { env, exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Tool } from '@modelcontextprotocol/server'
import type { D1StudioResult } from '../src/d1-studio/contract'
import { API_BASE, cfError, cfSuccess, mockIdentityProbe } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'
import { MCP_URL, modernMcpRequest, parseMcpResult } from './helpers/mcp'
import { clearSpec, seedSpec } from './helpers/spec'
import { server } from './setup/msw'

const ACCOUNT = '023e105f4ecef8ad9ca31a8372d0c353'
const DB = 'f4b2c1d0-0000-4000-8000-000000000001'
const TOKEN = 'd1-studio-token'
const DATABASE = `${API_BASE}/accounts/${ACCOUNT}/d1/database/${DB}`
const D1_PERMISSIONS = { 'x-api-token-group': ['D1 Read', 'D1 Write'] }

const raw = (columns: string[], rows: unknown[][], meta = { duration: 1, rows_read: 5 }) =>
  cfSuccess([{ results: { columns, rows }, meta, success: true }])

let sent: string[] = []

function mockD1(answer: (sql: string) => Response) {
  server.use(
    http.get(DATABASE, () =>
      HttpResponse.json(cfSuccess({ uuid: DB, name: 'partner_scheduling' }))
    ),
    http.post(`${DATABASE}/raw`, async ({ request }) => {
      const { sql } = (await request.json()) as { sql: string }
      sent.push(sql)
      if (sql.includes('sqlite_master'))
        return HttpResponse.json(
          raw(
            ['name', 'type'],
            [
              ['appointments', 'table'],
              ['partners', 'table']
            ]
          )
        )
      return answer(sql)
    })
  )
}

async function call(args: Record<string, unknown>, { mcpApps = false, url = MCP_URL } = {}) {
  const response = await exports.default.fetch(
    modernMcpRequest(TOKEN, 'tools/call', { name: 'd1_studio', arguments: args }, { url, mcpApps })
  )
  return (
    (await parseMcpResult(response)) as {
      result?: {
        isError?: boolean
        structuredContent?: D1StudioResult
        content?: { text: string }[]
        _meta?: Record<string, unknown>
      }
    }
  ).result!
}

beforeEach(async () => {
  sent = []
  await seedSpec(
    {
      '/accounts/{account_id}/d1/database/{database_id}': { get: D1_PERMISSIONS },
      '/accounts/{account_id}/d1/database/{database_id}/raw': { post: D1_PERMISSIONS }
    },
    ['d1']
  )
  mockIdentityProbe({ accounts: [{ id: ACCOUNT, name: 'D1 Co' }] })
})

afterEach(async () => {
  await clearSpec()
  await clearKv(env.OAUTH_KV)
})

describe('d1_studio', () => {
  it('runs the answer and the steps in order and shows each outcome', async () => {
    mockD1((sql) =>
      sql.includes('start_at')
        ? HttpResponse.json(
            cfError([
              { code: 7500, message: 'D1_ERROR: no such column: a.start_at: SQLITE_ERROR' }
            ]),
            {
              status: 400
            }
          )
        : HttpResponse.json(
            raw(
              ['partner', 'no_shows'],
              [
                ['Harbor Physio', 61],
                ['Glow', null]
              ]
            )
          )
    )
    const result = await call({
      database_id: DB,
      title: 'Top partners by no-shows',
      sql: 'SELECT partner, no_shows FROM appointments a LIMIT 10',
      steps: [
        {
          title: 'Statuses',
          sql: 'SELECT status FROM appointments',
          note: 'How a no-show is recorded'
        },
        { title: 'Typo', sql: 'SELECT a.start_at FROM appointments a' }
      ]
    })

    expect(result.isError).toBeFalsy()
    const value = result.structuredContent!
    expect(value.database).toEqual({ accountId: ACCOUNT, id: DB, name: 'partner_scheduling' })
    expect(value.tables).toEqual(['appointments', 'partners'])
    expect(value.answer).toMatchObject({
      purpose: 'query',
      title: 'Top partners by no-shows',
      outcome: { status: 'rows', columns: ['partner', 'no_shows'], rowCount: 2 }
    })
    expect(value.steps.map((s) => s.outcome.status)).toEqual(['rows', 'failed'])
    expect(value.steps[0]!.note).toBe('How a no-show is recorded')
    expect(value.steps[1]!.outcome).toEqual({
      status: 'failed',
      error: 'no such column: a.start_at',
      token: 'a.start_at'
    })
    // Steps run in order, before the answer.
    expect(sent.filter((s) => !s.includes('sqlite_master'))).toEqual([
      'SELECT status FROM appointments',
      'SELECT a.start_at FROM appointments a',
      'SELECT partner, no_shows FROM appointments a LIMIT 10'
    ])
  })

  it('lists the tables when no SQL is given, and says so for an empty database', async () => {
    server.use(
      http.get(DATABASE, () => HttpResponse.json(cfSuccess({ name: 'empty_db' }))),
      http.post(`${DATABASE}/raw`, () => HttpResponse.json(raw(['name', 'type'], [])))
    )
    const value = (await call({ database_id: DB })).structuredContent!
    expect(value.answer).toMatchObject({ purpose: 'tables', title: 'Tables in empty_db' })
    expect(value.answer.outcome).toMatchObject({ status: 'rows', rows: [] })
    expect(value.tables).toEqual([])
  })

  it('refuses a write or several statements without sending anything', async () => {
    mockD1(() => HttpResponse.json(raw([], [])))
    for (const sql of [
      'DELETE FROM appointments',
      'SELECT 1; SELECT 2',
      'PRAGMA foreign_keys = OFF'
    ]) {
      const result = await call({ database_id: DB, sql })
      expect(result.isError).toBe(true)
      expect(result.content![0]!.text).toMatch(/not a read|more than one statement/)
    }
    const step = await call({
      database_id: DB,
      sql: 'SELECT 1',
      steps: [{ title: 'Sneaky', sql: 'WITH x AS (SELECT 1) DELETE FROM appointments' }]
    })
    expect(step.isError).toBe(true)
    expect(step.content![0]!.text).toContain('Step 1 (Sneaky)')
    expect(sent).toEqual([])
  })

  it('explains a refused database read', async () => {
    server.use(
      http.get(DATABASE, () =>
        HttpResponse.json(cfError([{ code: 10000, message: 'Authentication error' }]), {
          status: 403
        })
      ),
      http.post(`${DATABASE}/raw`, () => HttpResponse.json(raw([], [])))
    )
    const result = await call({ database_id: DB, sql: 'SELECT 1' })
    expect(result.isError).toBe(true)
    expect(result.content![0]!.text).toContain(`GET /accounts/${ACCOUNT}/d1/database/${DB}`)
    expect(result.content![0]!.text).toContain('D1 Read')
  })

  it('gives the model at most 20 rows when the view shows the rest', async () => {
    const many = [...Array(150)].map((_, i) => [`p${i}`, i])
    mockD1(() => HttpResponse.json(raw(['partner', 'n'], many)))
    const args = { database_id: DB, sql: 'SELECT partner, n FROM partners' }

    const withView = await call(args, { mcpApps: true })
    const text = JSON.parse(withView.content![0]!.text) as {
      shown: string
      answer: { rows: unknown[]; note: string }
    }
    // The user sees the rows in the view, so the model is told not to repeat them.
    expect(text.shown).toContain('do not repeat the rows')
    expect(text.answer.rows).toHaveLength(20)
    expect(text.answer.note).toContain('First 20 of 150 rows')
    const outcome = withView.structuredContent!.answer.outcome
    expect(outcome.status === 'rows' && outcome.rows.length).toBe(150)

    // A client without Apps gets the whole result as text.
    const textOnly = await call(args)
    expect(JSON.parse(textOnly.content![0]!.text)).toEqual(textOnly.structuredContent)
    expect(textOnly.content![0]!.text).not.toContain('do not repeat the rows')
  })

  it('serves its App resource without account data', async () => {
    const response = await exports.default.fetch(
      modernMcpRequest(TOKEN, 'resources/read', { uri: 'ui://cloudflare/d1-studio.html' })
    )
    const body = JSON.stringify(await parseMcpResult(response))
    expect(body).toContain('text/html;profile=mcp-app')
    expect(body).not.toContain(ACCOUNT)
    expect(body).not.toContain(TOKEN)
  })
})

describe('re-runs from the view (Code Mode)', () => {
  it('lists d1_raw for the App only', async () => {
    const response = await exports.default.fetch(
      modernMcpRequest(TOKEN, 'tools/list', {}, { mcpApps: true })
    )
    const tools = ((await parseMcpResult(response)) as { result: { tools: Tool[] } }).result.tools
    expect(tools.find((t) => t.name === 'd1_raw')?._meta).toEqual({ ui: { visibility: ['app'] } })
    expect(tools.find((t) => t.name === 'd1_studio')?._meta).toMatchObject({
      ui: { resourceUri: 'ui://cloudflare/d1-studio.html' }
    })
  })

  it('answers a SQL error from d1_raw with D1’s body after the status line, which the view parses', async () => {
    mockD1(() =>
      HttpResponse.json(cfError([{ code: 7500, message: 'no such table: nope: SQLITE_ERROR' }]), {
        status: 400
      })
    )
    const response = await exports.default.fetch(
      modernMcpRequest(
        TOKEN,
        'tools/call',
        {
          name: 'd1_raw',
          arguments: {
            path: { account_id: ACCOUNT, database_id: DB },
            body: { sql: 'SELECT * FROM nope' }
          }
        },
        { mcpApps: true }
      )
    )
    const result = (
      (await parseMcpResult(response)) as {
        result: { isError?: boolean; content: { text: string }[] }
      }
    ).result
    expect(result.isError).toBe(true)
    const [status, body] = result.content[0]!.text.split('\n\n')
    expect(status).toMatch(/returned HTTP 400/)
    expect(JSON.parse(body!)).toMatchObject({ success: false, errors: [{ code: 7500 }] })
  })

  it.each([
    ['a write', { sql: 'DELETE FROM appointments' }],
    [
      'a write hidden after replace()',
      { sql: "WITH x AS (SELECT replace(a,'b','c') AS n FROM t) REPLACE INTO t2(n) SELECT n FROM x" }
    ],
    ['two statements', { sql: 'SELECT 1; DROP TABLE t' }],
    ['a batch', { batch: [{ sql: 'SELECT 1' }, { sql: 'DELETE FROM t' }] }]
  ])('refuses %s from the view before anything reaches D1', async (_, body) => {
    mockD1(() => HttpResponse.json(raw(['n'], [[1]])))
    const response = await exports.default.fetch(
      modernMcpRequest(
        TOKEN,
        'tools/call',
        { name: 'd1_raw', arguments: { path: { account_id: ACCOUNT, database_id: DB }, body } },
        { mcpApps: true }
      )
    )
    const result = (
      (await parseMcpResult(response)) as {
        result: { isError?: boolean; content: { text: string }[] }
      }
    ).result
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/D1 Studio runs/)
    expect(sent).toEqual([])
  })
})

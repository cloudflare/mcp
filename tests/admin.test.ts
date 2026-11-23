import { http, HttpResponse } from 'msw'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import worker, { type AdminEnv } from '../src/admin/worker'
import { verifyAccess } from '../src/admin/access'
import { runQuery, summary } from '../src/admin/analytics'
import { buildQueries, DATASETS, PERIODS, isDatasetEnv, isPeriodKey } from '../src/admin/queries'
import { renderPage } from '../src/admin/page'
import { isolate } from '../src/lib/isolate'
import { server } from './setup/msw'

const TEAM = 'https://example.cloudflareaccess.com'
const AUD = 'admin-aud-tag'
const API_BASE = 'https://api.cloudflare.com/client/v4'
const ACCOUNT = '6702657b6aa048cf3081ff3ff3c9c52f'
const SQL_URL = `${API_BASE}/accounts/${ACCOUNT}/analytics_engine/sql`
const KID = 'test-kid'

const ENV: AdminEnv = {
  CLOUDFLARE_API_BASE: API_BASE,
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  ANALYTICS_API_TOKEN: 'analytics-token',
  ACCESS_TEAM_DOMAIN: TEAM,
  ACCESS_AUD: AUD
}

let keys: CryptoKeyPair
let publicJwk: JsonWebKey

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256'
    },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair
  publicJwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey
})

afterEach(() => {
  isolate.resetAll()
  vi.restoreAllMocks()
})

function base64Url(bytes: Uint8Array | string): string {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

const now = () => Math.floor(Date.now() / 1000)

async function sign(
  payload: Record<string, unknown>,
  { kid = KID, key = keys.privateKey }: { kid?: string; key?: CryptoKey } = {}
): Promise<string> {
  const head = base64Url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))
  const body = base64Url(JSON.stringify(payload))
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(`${head}.${body}`)
  )
  return `${head}.${body}.${base64Url(new Uint8Array(signature))}`
}

const validClaims = () => ({
  iss: TEAM,
  aud: [AUD],
  exp: now() + 600,
  nbf: now() - 10,
  email: 'admin@cloudflare.com'
})

function serveCerts(kid = KID) {
  const certs = vi.fn(() => HttpResponse.json({ keys: [{ ...publicJwk, kid, alg: 'RS256' }] }))
  server.use(http.get(`${TEAM}/cdn-cgi/access/certs`, certs))
  return certs
}

function withToken(url: string, token: string): Request {
  return new Request(url, { headers: { 'Cf-Access-Jwt-Assertion': token } })
}

describe('verifyAccess', () => {
  const config = { teamDomain: TEAM, audience: AUD }

  it('accepts a token Access signed for this application', async () => {
    serveCerts()
    const result = await verifyAccess(
      withToken('https://admin/', await sign(validClaims())),
      config
    )
    expect(result).toEqual({ ok: true, email: 'admin@cloudflare.com' })
  })

  it('refuses everything when Access is not configured', async () => {
    const result = await verifyAccess(
      withToken('https://admin/', await sign(validClaims())),
      undefined
    )
    expect(result.ok).toBe(false)
  })

  it.each([
    ['a missing token', async () => new Request('https://admin/'), 'Missing'],
    ['a malformed token', async () => withToken('https://admin/', 'abc.def'), 'Malformed'],
    [
      'the wrong audience',
      async () => withToken('https://admin/', await sign({ ...validClaims(), aud: ['other'] })),
      'audience'
    ],
    [
      'the wrong issuer',
      async () =>
        withToken(
          'https://admin/',
          await sign({ ...validClaims(), iss: 'https://evil.cloudflareaccess.com' })
        ),
      'issuer'
    ],
    [
      'an expired token',
      async () => withToken('https://admin/', await sign({ ...validClaims(), exp: now() - 1 })),
      'expired'
    ],
    [
      'a token not yet valid',
      async () => withToken('https://admin/', await sign({ ...validClaims(), nbf: now() + 600 })),
      'not yet'
    ]
  ])('refuses %s', async (_name, build, reason) => {
    serveCerts()
    const result = await verifyAccess(await build(), config)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain(reason)
  })

  it('refuses a token signed with another key', async () => {
    serveCerts()
    const other = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256'
      },
      false,
      ['sign', 'verify']
    )) as CryptoKeyPair
    const token = await sign(validClaims(), { key: other.privateKey })
    expect(await verifyAccess(withToken('https://admin/', token), config)).toEqual({
      ok: false,
      reason: 'Invalid signature'
    })
  })

  it('refuses a token that is not RS256', async () => {
    serveCerts()
    const head = base64Url(JSON.stringify({ alg: 'none', kid: KID }))
    const token = `${head}.${base64Url(JSON.stringify(validClaims()))}.`
    expect((await verifyAccess(withToken('https://admin/', token), config)).ok).toBe(false)
  })

  it('caches the keys, and fetches them again for a kid it has not seen', async () => {
    const certs = serveCerts()
    await verifyAccess(withToken('https://admin/', await sign(validClaims())), config)
    await verifyAccess(withToken('https://admin/', await sign(validClaims())), config)
    expect(certs).toHaveBeenCalledTimes(1)

    const result = await verifyAccess(
      withToken('https://admin/', await sign(validClaims(), { kid: 'rotated' })),
      config
    )
    expect(result).toEqual({ ok: false, reason: 'Unknown signing key' })
    expect(certs).toHaveBeenCalledTimes(2)
  })
})

describe('queries', () => {
  it('accepts only the allowlisted envs and periods', () => {
    expect(isDatasetEnv('production')).toBe(true)
    expect(isDatasetEnv("production' OR 1=1 --")).toBe(false)
    expect(isDatasetEnv('toString')).toBe(false)
    expect(isPeriodKey('90d')).toBe(true)
    expect(isPeriodKey('365d')).toBe(false)
    expect(Object.keys(PERIODS)).toEqual(['24h', '7d', '14d', '30d', '90d'])
  })

  it('builds every query for the dataset, server and period', () => {
    const queries = buildQueries('staging', '24h')
    for (const sql of Object.values(queries)) {
      expect(sql).toContain(`FROM '${DATASETS.staging}'`)
      expect(sql).toContain("blob1 = 'cloudflare-api'")
      expect(sql).toContain("timestamp > NOW() - INTERVAL '24' HOUR")
    }
    expect(queries.toolTimeseries).toContain("toStartOfInterval(timestamp, INTERVAL '1' HOUR)")
    expect(queries.harnessTools).toContain('blob5 AS harness, blob4 AS tool')
    expect(queries.mismatchProducts).toContain('_sample_interval * double4')
    expect(buildQueries('production', '90d').tools).toContain("INTERVAL '90' DAY")
  })
})

describe('runQuery', () => {
  it('sends the SQL with the token and turns numeric strings into numbers', async () => {
    let received: { auth: string | null; body: string } | undefined
    server.use(
      http.post(SQL_URL, async ({ request }) => {
        received = { auth: request.headers.get('Authorization'), body: await request.text() }
        return HttpResponse.json({
          data: [
            { tool: '123', harness: 'opencode', calls: '42', errors: 3, t: '2026-11-23 10:00:00' }
          ]
        })
      })
    )

    const rows = await runQuery(
      { apiBase: API_BASE, accountId: ACCOUNT, apiToken: 'tok' },
      'SELECT 1'
    )

    expect(received).toEqual({ auth: 'Bearer tok', body: 'SELECT 1 FORMAT JSON' })
    expect(rows).toEqual([
      { tool: '123', harness: 'opencode', calls: 42, errors: 3, t: '2026-11-23 10:00:00' }
    ])
  })

  it('throws with the status when the SQL API refuses', async () => {
    server.use(http.post(SQL_URL, () => new HttpResponse('no access', { status: 403 })))
    await expect(
      runQuery({ apiBase: API_BASE, accountId: ACCOUNT, apiToken: 'tok' }, 'SELECT 1')
    ).rejects.toThrow('Analytics Engine answered 403: no access')
  })
})

describe('summary', () => {
  it('returns every panel, and reports a failed one without failing the rest', async () => {
    server.use(
      http.post(SQL_URL, async ({ request }) => {
        const sql = await request.text()
        if (sql.includes("index1 = 'auth_user'") && sql.includes('message')) {
          return new HttpResponse('boom', { status: 500 })
        }
        return HttpResponse.json({ data: [{ calls: '1' }] })
      })
    )

    const result = await summary(
      { apiBase: API_BASE, accountId: ACCOUNT, apiToken: 'tok' },
      'production',
      '7d',
      new Date('2026-11-23T00:00:00Z')
    )

    expect(Object.keys(result.panels).sort()).toEqual(
      Object.keys(buildQueries('production', '7d')).sort()
    )
    expect(result.panels.tools).toEqual([{ calls: 1 }])
    expect(result.panels.authErrors).toEqual([])
    expect(Object.keys(result.errors)).toEqual(['authErrors'])
    expect(result).toMatchObject({
      env: 'production',
      period: '7d',
      periodLabel: 'Last 7 days',
      generatedAt: '2026-11-23T00:00:00.000Z'
    })
  })
})

describe('admin worker', () => {
  it('refuses a request without an Access token', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const response = await worker.fetch(new Request('https://admin.example/'), ENV)
    expect(response.status).toBe(403)
  })

  it('refuses every request when Access is not configured', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    serveCerts()
    const response = await worker.fetch(
      withToken('https://admin.example/', await sign(validClaims())),
      { ...ENV, ACCESS_AUD: '' }
    )
    expect(response.status).toBe(403)
  })

  it('skips Access only for localhost with the dev bypass', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bypass = { ...ENV, ACCESS_DEV_BYPASS: 'true' }
    expect((await worker.fetch(new Request('http://localhost:2530/'), bypass)).status).toBe(200)
    expect((await worker.fetch(new Request('https://admin.example/'), bypass)).status).toBe(403)
  })

  it('serves the page with a nonced Content Security Policy', async () => {
    serveCerts()
    const response = await worker.fetch(
      withToken('https://admin.example/?env=staging&period=30d', await sign(validClaims())),
      ENV
    )
    const csp = response.headers.get('Content-Security-Policy')!
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1]
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(nonce).toBeTruthy()
    expect(csp).toContain("default-src 'none'")
    expect(html).toContain(`<script nonce="${nonce}">`)
    expect(html).toContain('data-env="staging" data-period="30d"')
    expect(html).toContain('admin@cloudflare.com')
  })

  it('serves the summary as JSON', async () => {
    serveCerts()
    server.use(http.post(SQL_URL, () => HttpResponse.json({ data: [] })))
    const response = await worker.fetch(
      withToken('https://admin.example/api/summary?env=dev&period=24h', await sign(validClaims())),
      ENV
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ env: 'dev', period: '24h', errors: {} })
  })

  it('rejects an unknown env or period on the API', async () => {
    serveCerts()
    const token = await sign(validClaims())
    const env = await worker.fetch(
      withToken('https://admin.example/api/summary?env=prod', token),
      ENV
    )
    const period = await worker.fetch(
      withToken('https://admin.example/api/summary?period=1y', token),
      ENV
    )
    expect(env.status).toBe(400)
    expect(period.status).toBe(400)
  })

  it('answers 405 to anything but GET', async () => {
    const response = await worker.fetch(
      new Request('https://admin.example/api/summary', { method: 'POST' }),
      ENV
    )
    expect(response.status).toBe(405)
  })
})

describe('renderPage', () => {
  it('escapes everything it puts into the HTML', () => {
    const html = renderPage({
      env: 'production',
      period: '7d',
      email: '<img src=x onerror=alert(1)>',
      nonce: 'n'
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

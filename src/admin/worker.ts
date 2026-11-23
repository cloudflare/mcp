/**
 * The admin dashboard (`wrangler.admin.jsonc`): tool usage by harness, users,
 * sign-ins and response schema mismatches from the `mcp-metrics-*` Analytics
 * Engine datasets, over 24 hours to 90 days.
 *
 * - `GET /`: the page (`src/admin/page.ts`).
 * - `GET /api/summary?env=production&period=7d`: every panel as JSON.
 *
 * Every request must carry a valid Cloudflare Access JWT (`src/admin/access.ts`).
 * The Worker queries with `ANALYTICS_API_TOKEN`, an API token with Account
 * Analytics Read on the account that owns the datasets, which never reaches the
 * page. It holds no other credentials and shares nothing with the MCP server.
 */
import { verifyAccess, type AccessConfig } from './access'
import { AnalyticsError, summary } from './analytics'
import { renderPage } from './page'
import { isDatasetEnv, isPeriodKey, type DatasetEnv, type PeriodKey } from './queries'

export interface AdminEnv {
  readonly CLOUDFLARE_API_BASE: string
  readonly CLOUDFLARE_ACCOUNT_ID: string
  /** Secret: an API token with Account Analytics Read on `CLOUDFLARE_ACCOUNT_ID`. */
  readonly ANALYTICS_API_TOKEN?: string
  /** `https://<team>.cloudflareaccess.com` */
  readonly ACCESS_TEAM_DOMAIN?: string
  /** The Access application's Application Audience (AUD) tag. */
  readonly ACCESS_AUD?: string
  /**
   * `true` skips the Access check for requests to localhost, for `wrangler dev`.
   * Set it only in `.dev.vars`; a deployed Worker is never served on localhost.
   */
  readonly ACCESS_DEV_BYPASS?: string
}

const DEFAULT_ENV: DatasetEnv = 'production'
const DEFAULT_PERIOD: PeriodKey = '7d'

function accessConfig(env: AdminEnv): AccessConfig | undefined {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return undefined
  return { teamDomain: env.ACCESS_TEAM_DOMAIN.replace(/\/+$/, ''), audience: env.ACCESS_AUD }
}

function isLocalDevBypass(request: Request, env: AdminEnv): boolean {
  const { hostname } = new URL(request.url)
  return env.ACCESS_DEV_BYPASS === 'true' && (hostname === 'localhost' || hostname === '127.0.0.1')
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'private, no-store'
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' }
  })
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }
  })
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}

export default {
  async fetch(request: Request, env: AdminEnv): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text('Method Not Allowed', 405)
    }

    let email: string | undefined
    if (!isLocalDevBypass(request, env)) {
      const access = await verifyAccess(request, accessConfig(env))
      if (!access.ok) {
        console.warn(`admin: refused ${new URL(request.url).pathname}: ${access.reason}`)
        return text('Forbidden', 403)
      }
      email = access.email
    }

    const url = new URL(request.url)
    const envParam = url.searchParams.get('env')
    const periodParam = url.searchParams.get('period')
    const datasetEnv = isDatasetEnv(envParam) ? envParam : DEFAULT_ENV
    const period = isPeriodKey(periodParam) ? periodParam : DEFAULT_PERIOD

    if (url.pathname === '/') {
      const nonce = randomNonce()
      return new Response(renderPage({ env: datasetEnv, period, email, nonce }), {
        headers: {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': [
            "default-src 'none'",
            `script-src 'nonce-${nonce}'`,
            `style-src 'nonce-${nonce}'`,
            "connect-src 'self'",
            "img-src 'self' data:",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'"
          ].join('; ')
        }
      })
    }

    if (url.pathname === '/api/summary') {
      if (envParam !== null && !isDatasetEnv(envParam)) return json({ error: 'Unknown env' }, 400)
      if (periodParam !== null && !isPeriodKey(periodParam)) {
        return json({ error: 'Unknown period' }, 400)
      }
      if (!env.ANALYTICS_API_TOKEN) return json({ error: 'ANALYTICS_API_TOKEN is not set' }, 500)
      try {
        return json(
          await summary(
            {
              apiBase: env.CLOUDFLARE_API_BASE,
              accountId: env.CLOUDFLARE_ACCOUNT_ID,
              apiToken: env.ANALYTICS_API_TOKEN
            },
            datasetEnv,
            period
          )
        )
      } catch (error) {
        const status = error instanceof AnalyticsError ? error.status : 500
        return json({ error: error instanceof Error ? error.message : String(error) }, status)
      }
    }

    return text('Not Found', 404)
  }
} satisfies ExportedHandler<AdminEnv>

import { z } from 'zod'

import type { AuthRequest, ClientInfo } from '@cloudflare/workers-oauth-provider'

const APPROVED_CLIENTS_COOKIE = '__Host-MCP_APPROVED_CLIENTS'
const CSRF_COOKIE = '__Host-CSRF_TOKEN'
const STATE_COOKIE = '__Host-CONSENTED_STATE'
const ONE_YEAR_IN_SECONDS = 31536000

/**
 * OAuth error class for handling OAuth-specific errors
 */
export class OAuthError extends Error {
  constructor(
    public code: string,
    public description: string,
    public statusCode = 400
  ) {
    super(description)
    this.name = 'OAuthError'
  }

  toResponse(): Response {
    return new Response(
      JSON.stringify({
        error: this.code,
        error_description: this.description
      }),
      {
        status: this.statusCode,
        headers: { 'Content-Type': 'application/json' }
      }
    )
  }

  toHtmlResponse(): Response {
    const titles: Record<string, string> = {
      invalid_request: 'Invalid Request',
      invalid_grant: 'Invalid Grant',
      invalid_client: 'Invalid Client',
      invalid_token: 'Invalid Token',
      unauthorized_client: 'Unauthorized Client',
      access_denied: 'Access Denied',
      unsupported_response_type: 'Unsupported Response Type',
      invalid_scope: 'Invalid Scope',
      insufficient_scope: 'Insufficient Scope',
      server_error: 'Server Error',
      temporarily_unavailable: 'Temporarily Unavailable'
    }
    const title = titles[this.code] || 'Authorization Error'
    return renderErrorPage(title, this.description, `Error code: ${this.code}`, this.statusCode)
  }
}

/**
 * Imports a secret key string for HMAC-SHA256 signing.
 */
async function importKey(secret: string): Promise<CryptoKey> {
  if (!secret) {
    throw new Error('Cookie secret is not defined')
  }
  const enc = new TextEncoder()
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign', 'verify']
  )
}

/**
 * Signs data using HMAC-SHA256.
 */
async function signData(key: CryptoKey, data: string): Promise<string> {
  const enc = new TextEncoder()
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Verifies an HMAC-SHA256 signature.
 */
async function verifySignature(
  key: CryptoKey,
  signatureHex: string,
  data: string
): Promise<boolean> {
  const enc = new TextEncoder()
  try {
    const signatureBytes = new Uint8Array(
      signatureHex.match(/.{1,2}/g)!.map((byte) => Number.parseInt(byte, 16))
    )
    return await crypto.subtle.verify('HMAC', key, signatureBytes.buffer, enc.encode(data))
  } catch {
    return false
  }
}

/**
 * Parses the signed cookie and verifies its integrity.
 */
async function getApprovedClientsFromCookie(
  cookieHeader: string | null,
  secret: string
): Promise<string[] | null> {
  if (!cookieHeader) return null

  const cookies = cookieHeader.split(';').map((c) => c.trim())
  const targetCookie = cookies.find((c) => c.startsWith(`${APPROVED_CLIENTS_COOKIE}=`))

  if (!targetCookie) return null

  const cookieValue = targetCookie.substring(APPROVED_CLIENTS_COOKIE.length + 1)
  const parts = cookieValue.split('.')

  if (parts.length !== 2) return null

  const [signatureHex, base64Payload] = parts
  const payload = atob(base64Payload)

  const key = await importKey(secret)
  const isValid = await verifySignature(key, signatureHex, payload)

  if (!isValid) return null

  try {
    const approvedClients = JSON.parse(payload)
    if (
      !Array.isArray(approvedClients) ||
      !approvedClients.every((item) => typeof item === 'string')
    ) {
      return null
    }
    return approvedClients as string[]
  } catch {
    return null
  }
}

/**
 * Checks if a given client ID has already been approved by the user.
 */
export async function clientIdAlreadyApproved(
  request: Request,
  clientId: string,
  cookieSecret: string
): Promise<boolean> {
  if (!clientId) return false
  const cookieHeader = request.headers.get('Cookie')
  const approvedClients = await getApprovedClientsFromCookie(cookieHeader, cookieSecret)
  return approvedClients?.includes(clientId) ?? false
}

/**
 * Scope template for preset selections
 */
export interface ScopeTemplate {
  name: string
  description: string
  tagline?: string
  scopes: readonly string[]
}

/**
 * Configuration for the approval dialog
 */
export interface ApprovalDialogOptions {
  client: ClientInfo | null
  server: {
    name: string
    logo?: string
    description?: string
  }
  state: Record<string, unknown>
  csrfToken: string
  setCookie: string
  scopeTemplates?: Record<string, ScopeTemplate>
  allScopes?: Record<string, string>
  defaultTemplate?: string
  maxScopes?: number
  requiredScopes?: readonly string[]
}

/**
 * Sanitizes HTML content to prevent XSS attacks
 */
function sanitizeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Override labels for resources whose humanized form would mangle acronyms
 * or brand names (e.g. `url_scanner` → "Url scanner", `cfone` → "Cfone").
 */
const RESOURCE_LABELS: Record<string, string> = {
  access: 'Access',
  ai: 'AI',
  aig: 'AI Gateway',
  aiaudit: 'AI Audit',
  'ai-search': 'AI Search',
  auditlogs: 'Audit logs',
  browser: 'Browser Rendering',
  cfone: 'Cloudflare One',
  connectivity: 'Connectivity',
  containers: 'Containers',
  d1: 'D1',
  dex: 'DEX',
  dns_analytics: 'DNS analytics',
  dns_records: 'DNS records',
  dns_settings: 'DNS settings',
  email_routing: 'Email routing',
  email_sending: 'Email sending',
  lb: 'Load Balancer',
  logpush: 'Logpush',
  mcp_portals: 'MCP Portals',
  notification: 'Notifications',
  offline_access: 'Offline access',
  pages: 'Pages',
  pipelines: 'Pipelines',
  queues: 'Queues',
  query_cache: 'Query Cache',
  r2_catalog: 'R2',
  radar: 'Radar',
  secrets_store: 'Secrets Store',
  'sso-connector': 'SSO Connector',
  ssl_certs: 'SSL certificates',
  teams: 'Teams (Zero Trust)',
  url_scanner: 'URL Scanner',
  user: 'User',
  account: 'Account',
  vectorize: 'Vectorize',
  workers: 'Workers',
  workers_builds: 'Workers Builds',
  workers_deployments: 'Workers Deployments',
  workers_kv: 'Workers KV',
  workers_observability: 'Workers Observability',
  workers_observability_telemetry: 'Workers Observability Telemetry',
  workers_routes: 'Workers Routes',
  workers_scripts: 'Workers Scripts',
  workers_tail: 'Workers Tail',
  zone: 'Zone'
}

/**
 * Turn a resource key like `workers_scripts` into a human-readable label.
 * Falls back to title-casing unknown keys.
 */
function humanize(key: string): string {
  if (RESOURCE_LABELS[key]) return RESOURCE_LABELS[key]
  const spaced = key.replace(/[_-]/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

interface ScopeRow {
  resource: string
  label: string
  category: string
  actions: Array<{ action: string; scope: string; desc: string; required: boolean }>
}

interface CategoryGroup {
  category: string
  rows: ScopeRow[]
}

/**
 * High-level category each resource belongs to — mirrors the grouping on the
 * Cloudflare dashboard's API token screen. Unknown resources fall through to "Other".
 */
const CATEGORY_MAP: Record<string, string> = {
  offline_access: 'Core',
  user: 'Core',
  account: 'Core',
  access: 'Access',
  workers: 'Developer Platform',
  workers_scripts: 'Developer Platform',
  workers_kv: 'Developer Platform',
  workers_routes: 'Developer Platform',
  workers_tail: 'Developer Platform',
  workers_deployments: 'Developer Platform',
  workers_builds: 'Developer Platform',
  workers_observability: 'Developer Platform',
  workers_observability_telemetry: 'Developer Platform',
  pages: 'Developer Platform',
  d1: 'Developer Platform',
  queues: 'Developer Platform',
  pipelines: 'Developer Platform',
  r2_catalog: 'Developer Platform',
  vectorize: 'Developer Platform',
  query_cache: 'Developer Platform',
  secrets_store: 'Developer Platform',
  containers: 'Developer Platform',
  mcp_portals: 'Developer Platform',
  ai: 'AI & Machine Learning',
  aig: 'AI & Machine Learning',
  aiaudit: 'AI & Machine Learning',
  'ai-search': 'AI & Machine Learning',
  dns_records: 'DNS & Zones',
  dns_settings: 'DNS & Zones',
  dns_analytics: 'DNS & Zones',
  zone: 'DNS & Zones',
  ssl_certs: 'DNS & Zones',
  logpush: 'Analytics & Logs',
  auditlogs: 'Analytics & Logs',
  lb: 'Networking',
  notification: 'Networking',
  connectivity: 'Networking',
  teams: 'Cloudflare One / Zero Trust',
  'sso-connector': 'Cloudflare One / Zero Trust',
  cfone: 'Cloudflare One / Zero Trust',
  dex: 'Cloudflare One / Zero Trust',
  browser: 'Browser & Rendering',
  url_scanner: 'App Security',
  radar: 'App Security',
  email_routing: 'Email & Messaging',
  email_sending: 'Email & Messaging'
}

const CATEGORY_ORDER = [
  'Core',
  'Access',
  'Developer Platform',
  'AI & Machine Learning',
  'DNS & Zones',
  'Analytics & Logs',
  'Networking',
  'Browser & Rendering',
  'Email & Messaging',
  'App Security',
  'Cloudflare One / Zero Trust',
  'Other'
]

/**
 * Group scopes by resource, then bucket rows by category for accordion display.
 */
function groupScopesByCategory(
  allScopes: Record<string, string>,
  requiredScopes: Set<string>
): CategoryGroup[] {
  const byResource = new Map<string, ScopeRow>()

  for (const [scope, desc] of Object.entries(allScopes)) {
    const [resource, action = 'grant'] = scope.includes(':') ? scope.split(':') : [scope]
    const category = CATEGORY_MAP[resource] ?? 'Other'
    if (!byResource.has(resource)) {
      byResource.set(resource, { resource, label: humanize(resource), category, actions: [] })
    }
    byResource.get(resource)!.actions.push({
      action,
      scope,
      desc,
      required: requiredScopes.has(scope)
    })
  }

  const actionRank: Record<string, number> = {
    read: 0,
    write: 1,
    edit: 1,
    run: 2,
    admin: 3,
    bind: 4,
    setup: 5,
    pii: 9,
    secure_location: 9,
    grant: -1
  }
  for (const row of byResource.values()) {
    row.actions.sort((a, b) => {
      const ra = actionRank[a.action] ?? 5
      const rb = actionRank[b.action] ?? 5
      return ra === rb ? a.action.localeCompare(b.action) : ra - rb
    })
  }

  const byCategory = new Map<string, ScopeRow[]>()
  for (const row of byResource.values()) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, [])
    byCategory.get(row.category)!.push(row)
  }
  for (const rows of byCategory.values()) {
    rows.sort((a, b) => a.label.localeCompare(b.label))
  }

  const ordered: CategoryGroup[] = []
  for (const category of CATEGORY_ORDER) {
    const rows = byCategory.get(category)
    if (rows) ordered.push({ category, rows })
  }
  for (const [category, rows] of byCategory) {
    if (!CATEGORY_ORDER.includes(category)) ordered.push({ category, rows })
  }
  return ordered
}

const ACTION_LABELS: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  run: 'Run',
  admin: 'Admin',
  bind: 'Bind',
  setup: 'Setup',
  pii: 'PII',
  secure_location: 'Locations',
  grant: 'Grant'
}

/**
 * Renders an approval dialog for OAuth authorization with scope selection
 */
export function renderApprovalDialog(request: Request, options: ApprovalDialogOptions): Response {
  const {
    client,
    state,
    csrfToken,
    setCookie,
    scopeTemplates = {},
    allScopes = {},
    defaultTemplate,
    maxScopes,
    requiredScopes = []
  } = options

  const encodedState = btoa(JSON.stringify(state))
  const clientName = client?.clientName ? sanitizeHtml(client.clientName) : 'Unknown MCP Client'
  const requiredSet = new Set(requiredScopes)
  const categories = groupScopesByCategory(allScopes, requiredSet)

  const renderRow = (row: ScopeRow): string => {
    const pills = row.actions
      .map((a) => {
        const label = ACTION_LABELS[a.action] ?? humanize(a.action)
        const classes = ['pill']
        if (a.required) classes.push('pill--required')
        return `<button type="button" class="${classes.join(' ')}" data-scope="${sanitizeHtml(a.scope)}" data-action="${sanitizeHtml(a.action)}" data-required="${a.required ? '1' : ''}" title="${sanitizeHtml(a.scope)} — ${sanitizeHtml(a.desc)}" aria-pressed="false"><span class="pill-box" aria-hidden="true"></span><span class="pill-label">${sanitizeHtml(label)}</span></button>`
      })
      .join('')
    const hasRequired = row.actions.some((a) => a.required)
    return `
          <div class="row" data-resource="${sanitizeHtml(row.resource)}" data-search="${sanitizeHtml((row.label + ' ' + row.resource + ' ' + row.category).toLowerCase())}">
            <div class="row-label">
              <span class="row-name">${sanitizeHtml(row.label)}</span>
              ${hasRequired ? '<span class="row-badge">Required</span>' : ''}
            </div>
            <div class="row-pills">${pills}</div>
          </div>`
  }

  const categoriesHtml = categories
    .map((g) => {
      return `
        <details class="cat" data-category="${sanitizeHtml(g.category)}">
          <summary class="cat-summary">
            <span class="cat-chevron" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
            </span>
            <span class="cat-name">${sanitizeHtml(g.category)}</span>
            <span class="cat-count" data-count></span>
          </summary>
          <div class="cat-body">
            ${g.rows.map(renderRow).join('')}
          </div>
        </details>`
    })
    .join('')

  const templateDataJson = JSON.stringify(
    Object.fromEntries(Object.entries(scopeTemplates).map(([k, v]) => [k, v.scopes]))
  )

  const templateMetaJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(scopeTemplates).map(([k, v]) => [
        k,
        { name: v.name, tagline: v.tagline ?? '', description: v.description }
      ])
    )
  )

  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize ${clientName} | Cloudflare</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      /* Kumo-derived tokens (see @cloudflare/kumo/theme-kumo.css) */
      --cf-brand: #f6821f;
      --cf-brand-hover: #e5750f;
      --cf-brand-tint: rgba(246, 130, 31, 0.08);
      --cf-base: #ffffff;             /* kumo-base */
      --cf-canvas: #fbfbfb;           /* kumo-canvas  oklch(98.75% 0 0) */
      --cf-elevated: #fafafa;         /* kumo-elevated oklch(98% 0 0)  */
      --cf-tint: #f7f7f7;             /* neutral-100  oklch(97% 0 0)   */
      --cf-recessed: #f5f5f5;         /* kumo-recessed oklch(96% 0 0)  */
      --cf-hairline: #eeeeee;         /* kumo-hairline oklch(93.5% 0 0)*/
      --cf-line: rgba(37, 37, 37, 0.1); /* kumo-line oklch(14.5% 0 0 / 0.1) */
      --cf-interact: #d4d4d4;         /* neutral-300 oklch(87% 0 0)    */
      --cf-contrast: #262626;         /* kumo-contrast (checked state) */
      --cf-text-default: #262626;     /* neutral-900 oklch(21% ...)    */
      --cf-text-strong: #636363;      /* neutral-600 oklch(43.9% 0 0)  */
      --cf-text-subtle: #808080;      /* neutral-500 oklch(55.6% 0 0)  */
      --cf-text-inactive: #a3a3a3;    /* neutral-400 oklch(70.8% 0 0)  */
      --cf-red: #c0392b;
      --border-radius-sm: 2px;
      --border-radius: 8px;
      --border-radius-lg: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter Variable', 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      font-feature-settings: 'cv11', 'ss01';
      font-size: 14px;
      line-height: 1.5;
      letter-spacing: -0.01em;
      color: var(--cf-text-default);
      background: var(--cf-canvas);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Header */
    .header {
      padding: 1rem 2rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      border-bottom: 1px solid var(--cf-hairline);
      background: white;
    }
    .cf-logo { display: flex; align-items: center; gap: 0.5rem; text-decoration: none; color: inherit; }
    .cf-logo img { height: 32px; width: auto; }
    .cf-logo-divider { width: 1px; height: 24px; background: var(--cf-interact); margin: 0 0.5rem; }
    .cf-logo-product { font-size: 14px; color: var(--cf-text-subtle); }

    /* Main */
    .main {
      flex: 1;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      background: var(--cf-base);
      border: 1px solid var(--cf-hairline);
      border-radius: var(--border-radius-lg);
      width: 100%;
      max-width: 640px;
      overflow: hidden;
    }
    .card-header {
      padding: 1.5rem 2rem;
      border-bottom: 1px solid var(--cf-hairline);
      text-align: center;
    }
    .card-title { font-size: 18px; font-weight: 600; color: var(--cf-text-default); letter-spacing: -0.18px; margin-bottom: 0.25rem; }
    .card-subtitle { font-size: 14px; color: var(--cf-text-subtle); letter-spacing: -0.16px; }
    .card-body { padding: 1.5rem 2rem; }

    /* Client badge */
    .client-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--cf-elevated);
      padding: 0.45rem 0.85rem;
      border-radius: var(--border-radius);
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 1.5rem;
      border: 1px solid var(--cf-hairline);
    }
    .client-badge-icon {
      width: 20px;
      height: 20px;
      background: var(--cf-brand);
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .client-badge-icon svg { width: 12px; height: 12px; }

    /* Section labels (match dashboard 'Edit policy' heading: 14px/500/subtle) */
    .section { margin-bottom: 1.5rem; }
    .section-label {
      font-size: 14px;
      font-weight: 500;
      letter-spacing: -0.16px;
      color: var(--cf-text-subtle);
      margin-bottom: 0.75rem;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .info-tip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      color: var(--cf-text-inactive);
      cursor: help;
      position: relative;
    }
    .info-tip svg { width: 14px; height: 14px; }
    .info-tip:hover { color: var(--cf-text-subtle); }
    .info-tip[data-tip]::after {
      content: attr(data-tip);
      position: absolute;
      bottom: calc(100% + 6px);
      left: 50%;
      transform: translateX(-50%);
      background: var(--cf-contrast);
      color: #fff;
      font-size: 12px;
      font-weight: 400;
      letter-spacing: -0.12px;
      padding: 6px 10px;
      border-radius: 6px;
      white-space: nowrap;
      max-width: 280px;
      white-space: normal;
      width: max-content;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.12s ease;
      z-index: 50;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    }
    .info-tip[data-tip]::before {
      content: '';
      position: absolute;
      bottom: calc(100% + 2px);
      left: 50%;
      transform: translateX(-50%);
      border: 4px solid transparent;
      border-top-color: var(--cf-contrast);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.12s ease;
      z-index: 50;
    }
    .info-tip[data-tip]:hover::after,
    .info-tip[data-tip]:hover::before,
    .info-tip[data-tip]:focus::after,
    .info-tip[data-tip]:focus::before { opacity: 1; }

    /* Templates */
    .templates {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .tmpl {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.45rem 0.8rem;
      border: 1px solid var(--cf-interact);
      border-radius: var(--border-radius);
      background: var(--cf-base);
      cursor: pointer;
      font-family: inherit;
      color: var(--cf-text-default);
      transition: all 0.12s ease;
    }
    .tmpl:hover { border-color: var(--cf-text-subtle); background: var(--cf-elevated); }
    .tmpl[aria-pressed="true"] {
      background: var(--cf-brand-tint);
      border-color: var(--cf-brand);
      color: var(--cf-brand-hover);
      box-shadow: inset 0 0 0 1px var(--cf-brand);
    }
    .tmpl[aria-pressed="true"] .tmpl-tag { color: var(--cf-brand); }
    .tmpl .tmpl-name { font-size: 14px; font-weight: 500; letter-spacing: -0.14px; }
    .tmpl .tmpl-tag {
      font-size: 12px;
      color: var(--cf-text-subtle);
      letter-spacing: -0.12px;
      font-weight: 500;
    }
    .tmpl .tmpl-delete {
      width: 16px;
      height: 16px;
      border: none;
      background: transparent;
      cursor: pointer;
      color: currentColor;
      opacity: 0.5;
      padding: 0;
      display: none;
      align-items: center;
      justify-content: center;
      margin-left: 0.15rem;
    }
    .tmpl[data-user="1"] .tmpl-delete { display: inline-flex; }
    .tmpl .tmpl-delete:hover { opacity: 1; color: var(--cf-red); }
    .tmpl[aria-pressed="true"] .tmpl-delete:hover { color: var(--cf-red); opacity: 1; }
    .tmpl--custom { border-style: dashed; }

    /* Matrix head */
    .matrix-head {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.75rem;
    }
    .search {
      flex: 1;
      position: relative;
    }
    .search input {
      width: 100%;
      padding: 0.55rem 0.85rem 0.55rem 2rem;
      border: 1px solid var(--cf-interact);
      border-radius: var(--border-radius);
      font-family: inherit;
      font-size: 14px;
      background: white;
      color: var(--cf-text-default);
      outline: none;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .search input:focus {
      border-color: var(--cf-brand);
      box-shadow: 0 0 0 3px var(--cf-brand-tint);
    }
    .search svg {
      position: absolute;
      left: 0.65rem;
      top: 50%;
      transform: translateY(-50%);
      width: 14px;
      height: 14px;
      color: var(--cf-text-inactive);
    }
    .counter {
      font-size: 12px;
      color: var(--cf-text-subtle);
      white-space: nowrap;
      font-weight: 500;
      letter-spacing: -0.12px;
    }
    .counter.warn { color: var(--cf-red); }

    /* Categories (accordions). Kumo 'permission policies' panel — match
       body canvas bg so the table looks recessed into the card. */
    .categories {
      background: var(--cf-canvas);
      border-radius: var(--border-radius);
      box-shadow: 0 0 0 1px var(--cf-hairline);
      overflow: hidden;
    }
    .cat {
      border-bottom: 1px dashed var(--cf-line);
    }
    .cat:last-child { border-bottom: none; }
    .cat-summary {
      list-style: none;
      padding: 0.75rem 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      color: var(--cf-text-default);
      letter-spacing: -0.14px;
      background: transparent;
      transition: background 0.12s ease;
      user-select: none;
    }
    .cat-summary::-webkit-details-marker { display: none; }
    .cat-summary:hover { background: rgba(37, 37, 37, 0.03); }
    .cat-chevron {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      color: var(--cf-text-subtle);
      transition: transform 0.2s ease;
    }
    .cat[open] > .cat-summary .cat-chevron { transform: rotate(90deg); }
    .cat-name { flex: 1; }
    .cat-count {
      font-size: 12px;
      color: var(--cf-text-subtle);
      font-weight: 500;
      font-variant-numeric: tabular-nums;
    }
    .cat-count.has { color: var(--cf-brand); }
    .cat-body {
      background: transparent;
    }

    /* Rows */
    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 1rem;
      align-items: center;
      min-height: 48px;
      padding: 0 1rem 0 2.4rem;
      border-top: 1px dashed var(--cf-line);
    }
    .cat-body .row:first-child { border-top: none; }
    .row.hidden { display: none; }
    .row-label { min-width: 0; }
    .row-name {
      font-size: 14px;
      font-weight: 400;
      color: var(--cf-text-strong);
      letter-spacing: -0.16px;
    }
    .row-badge {
      margin-left: 0.5rem;
      font-size: 12px;
      font-weight: 500;
      color: var(--cf-brand);
      letter-spacing: -0.1px;
    }
    /* Kumo action-group container (dashboard "permission policies" row):
       px-1.5 gap-3 ring-1 ring-kumo-line rounded-md h-7 bg-kumo-control */
    .row-pills {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      height: 28px;
      padding: 0 6px;
      border-radius: 6px;
      background: var(--cf-base);
      box-shadow: 0 0 0 1px var(--cf-line);
      flex-wrap: nowrap;
    }
    /* Action checkbox (matches Kumo Checkbox primitive).
       The button element IS the checkbox; .pill-box is the 16px visual. */
    .pill {
      font-family: inherit;
      font-size: 13px;
      font-weight: 400;
      letter-spacing: -0.13px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 0;
      margin: 0;
      border: none;
      background: transparent;
      color: var(--cf-text-strong);
      cursor: pointer;
      min-height: 0;
    }
    .pill-box {
      width: 16px;
      height: 16px;
      border-radius: var(--border-radius-sm);
      background: var(--cf-base);
      box-shadow: 0 0 0 1px var(--cf-hairline);
      flex-shrink: 0;
      position: relative;
      transition: background 0.12s ease, box-shadow 0.12s ease;
    }
    .pill:hover .pill-box { box-shadow: 0 0 0 1px var(--cf-interact); }
    .pill[aria-pressed="true"] .pill-box {
      background-color: var(--cf-contrast);
      box-shadow: 0 0 0 1px var(--cf-contrast);
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='3.5,8.2 6.5,11 12.5,5'/></svg>");
      background-size: 12px 12px;
      background-position: center;
      background-repeat: no-repeat;
    }
    .pill-label { line-height: 1; }
    .pill--required { cursor: not-allowed; opacity: 0.5; }
    .pill[aria-pressed="true"].pill--required .pill-box {
      background-color: var(--cf-text-inactive);
      box-shadow: 0 0 0 1px var(--cf-text-inactive);
    }
    .pill:disabled { opacity: 0.4; cursor: not-allowed; }

    /* Save as inline */
    .save-as {
      display: none;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.75rem;
      padding: 0.75rem;
      background: var(--cf-tint);
      border: 1px solid var(--cf-hairline);
      border-radius: var(--border-radius);
    }
    .save-as.open { display: flex; }
    .save-as input {
      flex: 1;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--cf-interact);
      border-radius: 6px;
      font-family: inherit;
      font-size: 14px;
      outline: none;
      background: white;
    }
    .save-as input:focus { border-color: var(--cf-brand); box-shadow: 0 0 0 3px var(--cf-brand-tint); }

    /* Actions */
    .actions {
      display: flex;
      gap: 0.5rem;
      padding-top: 1rem;
      border-top: 1px solid var(--cf-hairline);
      flex-wrap: wrap;
    }
    .button {
      padding: 0.55rem 1rem;
      border-radius: var(--border-radius);
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      font-size: 14px;
      font-family: inherit;
      transition: all 0.15s ease;
      text-align: center;
    }
    .button-primary { background: var(--cf-brand); color: white; border-color: var(--cf-brand); flex: 1; }
    .button-primary:hover { background: var(--cf-brand-hover); border-color: var(--cf-brand-hover); }
    .button-primary:disabled { background: var(--cf-tint); border-color: var(--cf-hairline); color: var(--cf-text-inactive); cursor: not-allowed; }
    .button-outline {
      background: var(--cf-base);
      border-color: var(--cf-interact);
      color: var(--cf-text-default);
    }
    .button-outline:hover { background: var(--cf-elevated); border-color: var(--cf-text-subtle); }
    .button-outline:disabled { border-color: var(--cf-hairline); color: var(--cf-text-inactive); cursor: not-allowed; background: var(--cf-base); }
    .button-ghost {
      background: transparent;
      color: var(--cf-text-subtle);
    }
    .button-ghost:hover { color: var(--cf-text-default); }

    /* Footer */
    .footer {
      padding: 1rem 2rem;
      text-align: center;
      font-size: 12px;
      color: var(--cf-text-inactive);
      border-top: 1px solid var(--cf-hairline);
      background: white;
    }
    .footer a { color: var(--cf-text-subtle); text-decoration: none; }
    .footer a:hover { color: var(--cf-brand); }

    @media (max-width: 600px) {
      .main { padding: 1rem; }
      .card-body { padding: 1.25rem; }
      .matrix-head { flex-direction: column; align-items: stretch; }
      .row { grid-template-columns: 1fr; gap: 0.5rem; }
      .row-pills { justify-content: flex-start; }
      .button-primary { flex: 1 1 100%; order: -1; }
    }
  </style>
</head>
<body>
  <header class="header">
    <a href="https://cloudflare.com" class="cf-logo">
      <img src="https://www.cloudflare.com/img/logo-cloudflare-dark.svg" alt="Cloudflare" height="32">
    </a>
    <div class="cf-logo-divider"></div>
    <span class="cf-logo-product">MCP Server</span>
  </header>

  <main class="main">
    <div class="card">
      <div class="card-header">
        <h1 class="card-title">Authorize Application</h1>
        <p class="card-subtitle">Grant access to Cloudflare API</p>
      </div>

      <div class="card-body">
        <div class="client-badge">
          <span class="client-badge-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg>
          </span>
          ${clientName}
        </div>

        <form method="post" action="${new URL(request.url).pathname}" id="authForm">
          <input type="hidden" name="state" value="${encodedState}">
          <input type="hidden" name="csrf_token" value="${csrfToken}">
          <div id="hiddenScopes"></div>

          <div class="section">
            <div class="section-label">
              Access template
              <span class="info-tip" tabindex="0" data-tip="Pick a built-in preset or customize individual scopes. Save custom selections as templates (stored in this browser).">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 11V7.5"/><circle cx="8" cy="5" r="0.5" fill="currentColor"/></svg>
              </span>
            </div>
            <div class="templates" id="templates" role="radiogroup" aria-label="Permission templates"></div>
          </div>

          <div class="section">
            <div class="section-label">
              Permissions
              <span class="info-tip" tabindex="0" data-tip="Individual OAuth scopes granted to this client. Required scopes (user, account, offline access) are always included.">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 11V7.5"/><circle cx="8" cy="5" r="0.5" fill="currentColor"/></svg>
              </span>
            </div>
            <div class="matrix-head">
              <div class="search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
                </svg>
                <input type="search" id="search" placeholder="Search for permission groups..." autocomplete="off">
              </div>
              <div class="counter" id="counter"><strong>0</strong> / ${maxScopes ?? Object.keys(allScopes).length}</div>
            </div>
            <div class="categories" id="matrix">
              ${categoriesHtml}
            </div>
            <div class="save-as" id="saveAs">
              <input type="text" id="saveAsName" placeholder="Template name" maxlength="40">
              <button type="button" class="button button-outline" id="saveAsConfirm">Save</button>
              <button type="button" class="button button-ghost" id="saveAsCancel">Cancel</button>
            </div>
          </div>

          <div class="actions">
            <button type="button" class="button button-ghost" onclick="window.close()">Cancel</button>
            <button type="button" class="button button-outline" id="saveAsOpen" disabled>Save as template</button>
            <button type="submit" class="button button-primary" id="continueBtn">Continue</button>
          </div>
        </form>
      </div>
    </div>
  </main>

  <footer class="footer">
    <a href="https://cloudflare.com/privacypolicy">Privacy</a> ·
    <a href="https://cloudflare.com/terms">Terms</a> ·
    <a href="https://developers.cloudflare.com">Docs</a>
  </footer>

  <script>
    (function() {
      const TEMPLATES = ${templateDataJson};
      const TEMPLATE_META = ${templateMetaJson};
      const DEFAULT_TEMPLATE = ${JSON.stringify(defaultTemplate ?? null)};
      const MAX_SCOPES = ${maxScopes ?? 0};
      const REQUIRED = new Set(${JSON.stringify(Array.from(requiredSet))});
      const ALL_SCOPES = new Set(${JSON.stringify(Object.keys(allScopes))});
      const LS_KEY = 'cf-mcp-consent:user-templates:v1';

      const selected = new Set();
      let activeTemplate = null;
      let dirty = false;

      const templatesEl = document.getElementById('templates');
      const matrixEl = document.getElementById('matrix');
      const counterEl = document.getElementById('counter');
      const searchEl = document.getElementById('search');
      const hiddenScopesEl = document.getElementById('hiddenScopes');
      const continueBtn = document.getElementById('continueBtn');
      const saveAsOpen = document.getElementById('saveAsOpen');
      const saveAs = document.getElementById('saveAs');
      const saveAsName = document.getElementById('saveAsName');
      const saveAsConfirm = document.getElementById('saveAsConfirm');
      const saveAsCancel = document.getElementById('saveAsCancel');

      function loadUserTemplates() {
        try {
          const raw = localStorage.getItem(LS_KEY);
          if (!raw) return [];
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed)) return [];
          return parsed
            .filter(t => t && typeof t.name === 'string' && Array.isArray(t.scopes))
            .map(t => ({
              name: String(t.name).slice(0, 40),
              scopes: t.scopes.filter(s => typeof s === 'string' && ALL_SCOPES.has(s))
            }));
        } catch { return []; }
      }

      function saveUserTemplates(list) {
        try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch {}
      }

      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }

      function renderTemplates() {
        const user = loadUserTemplates();
        const entries = [];
        for (const [key, meta] of Object.entries(TEMPLATE_META)) {
          entries.push({ key, name: meta.name, tagline: meta.tagline, user: false });
        }
        for (const t of user) {
          entries.push({ key: 'user:' + t.name, name: t.name, tagline: '', user: true });
        }
        entries.push({ key: '__custom__', name: 'Custom', tagline: '', user: false, custom: true });

        templatesEl.innerHTML = entries.map(e => {
          const classes = ['tmpl'];
          if (e.custom) classes.push('tmpl--custom');
          return \`
            <button type="button" class="\${classes.join(' ')}" data-key="\${escapeHtml(e.key)}" data-user="\${e.user ? '1' : ''}" aria-pressed="false" role="radio">
              <span class="tmpl-name">\${escapeHtml(e.name)}</span>
              \${e.tagline ? '<span class="tmpl-tag">' + escapeHtml(e.tagline) + '</span>' : ''}
              \${e.user ? '<span class="tmpl-delete" data-delete="' + escapeHtml(e.key) + '" aria-label="Delete template" title="Delete"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg></span>' : ''}
            </button>
          \`;
        }).join('');

        templatesEl.querySelectorAll('.tmpl').forEach(btn => {
          btn.addEventListener('click', (ev) => {
            if (ev.target.closest('[data-delete]')) return;
            const key = btn.dataset.key;
            if (key === '__custom__') {
              setActiveTemplate('__custom__');
              return;
            }
            applyTemplate(key);
          });
        });
        templatesEl.querySelectorAll('[data-delete]').forEach(el => {
          el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const key = el.dataset.delete;
            const name = key.slice('user:'.length);
            const next = loadUserTemplates().filter(t => t.name !== name);
            saveUserTemplates(next);
            if (activeTemplate === key) {
              applyTemplate(DEFAULT_TEMPLATE || '__custom__');
            }
            renderTemplates();
            updateActiveTemplateUI();
          });
        });
      }

      function resolveTemplateScopes(key) {
        if (TEMPLATES[key]) return TEMPLATES[key];
        if (key && key.startsWith('user:')) {
          const name = key.slice('user:'.length);
          const found = loadUserTemplates().find(t => t.name === name);
          return found ? found.scopes : null;
        }
        return null;
      }

      function applyTemplate(key) {
        const scopes = resolveTemplateScopes(key);
        if (!scopes) {
          setActiveTemplate('__custom__');
          return;
        }
        selected.clear();
        for (const s of scopes) if (ALL_SCOPES.has(s)) selected.add(s);
        for (const r of REQUIRED) selected.add(r);
        dirty = false;
        setActiveTemplate(key);
        syncPills();
      }

      function setActiveTemplate(key) {
        activeTemplate = key;
        updateActiveTemplateUI();
        updateFooter();
      }

      function updateActiveTemplateUI() {
        templatesEl.querySelectorAll('.tmpl').forEach(btn => {
          btn.setAttribute('aria-pressed', btn.dataset.key === activeTemplate ? 'true' : 'false');
        });
      }

      function matchesExistingTemplate() {
        const currentScopes = Array.from(selected).sort().join(',');
        for (const [key, scopes] of Object.entries(TEMPLATES)) {
          const withReq = new Set(scopes);
          for (const r of REQUIRED) withReq.add(r);
          const s = Array.from(withReq).sort().join(',');
          if (s === currentScopes) return key;
        }
        for (const t of loadUserTemplates()) {
          const withReq = new Set(t.scopes);
          for (const r of REQUIRED) withReq.add(r);
          const s = Array.from(withReq).sort().join(',');
          if (s === currentScopes) return 'user:' + t.name;
        }
        return null;
      }

      function syncPills() {
        matrixEl.querySelectorAll('.pill').forEach(pill => {
          const scope = pill.dataset.scope;
          pill.setAttribute('aria-pressed', selected.has(scope) ? 'true' : 'false');
        });
        enforceLimit();
        updateCounter();
        updateCategoryCounts();
        renderHiddenInputs();
      }

      function enforceLimit() {
        if (!MAX_SCOPES) return;
        const atMax = selected.size >= MAX_SCOPES;
        matrixEl.querySelectorAll('.pill').forEach(pill => {
          if (pill.dataset.required) return;
          const scope = pill.dataset.scope;
          pill.disabled = !selected.has(scope) && atMax;
        });
      }

      function updateCounter() {
        const count = selected.size;
        const max = MAX_SCOPES || ALL_SCOPES.size;
        counterEl.innerHTML = '<strong>' + count + '</strong> / ' + max;
        counterEl.classList.toggle('warn', MAX_SCOPES > 0 && count >= MAX_SCOPES);
      }

      function updateCategoryCounts() {
        matrixEl.querySelectorAll('.cat').forEach(cat => {
          const pills = cat.querySelectorAll('.pill');
          let on = 0;
          pills.forEach(p => { if (selected.has(p.dataset.scope)) on++; });
          const countEl = cat.querySelector('[data-count]');
          if (countEl) {
            countEl.textContent = on > 0 ? on + ' selected' : '';
            countEl.classList.toggle('has', on > 0);
          }
        });
      }

      function updateFooter() {
        const count = selected.size;
        const onTemplate = !dirty && activeTemplate && activeTemplate !== '__custom__';
        saveAsOpen.disabled = onTemplate || count === 0;
        continueBtn.disabled = count === 0;
      }

      function renderHiddenInputs() {
        hiddenScopesEl.innerHTML = '';
        for (const s of selected) {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = 'scopes';
          input.value = s;
          hiddenScopesEl.appendChild(input);
        }
        if (activeTemplate && activeTemplate !== '__custom__') {
          const input = document.createElement('input');
          input.type = 'hidden';
          input.name = 'scope_template';
          input.value = activeTemplate;
          hiddenScopesEl.appendChild(input);
        }
      }

      function onPillClick(ev) {
        const pill = ev.target.closest('.pill');
        if (!pill || pill.disabled) return;
        if (pill.dataset.required) return;
        const scope = pill.dataset.scope;
        if (selected.has(scope)) selected.delete(scope);
        else selected.add(scope);
        dirty = true;

        const match = matchesExistingTemplate();
        if (match) {
          activeTemplate = match;
          dirty = false;
        } else {
          activeTemplate = '__custom__';
        }

        updateActiveTemplateUI();
        syncPills();
        updateFooter();
      }

      function onSearch() {
        const q = searchEl.value.trim().toLowerCase();
        matrixEl.querySelectorAll('.row').forEach(row => {
          const hay = row.dataset.search || '';
          row.classList.toggle('hidden', q.length > 0 && !hay.includes(q));
        });
        matrixEl.querySelectorAll('.cat').forEach(cat => {
          const visibleRows = cat.querySelectorAll('.row:not(.hidden)');
          cat.classList.toggle('hidden', q.length > 0 && visibleRows.length === 0);
          if (q.length > 0 && visibleRows.length > 0) cat.setAttribute('open', '');
        });
      }

      function openSaveAs() {
        saveAs.classList.add('open');
        saveAsOpen.style.display = 'none';
        saveAsName.value = '';
        saveAsName.focus();
      }
      function closeSaveAs() {
        saveAs.classList.remove('open');
        saveAsOpen.style.display = '';
      }
      function confirmSaveAs() {
        const name = saveAsName.value.trim().slice(0, 40);
        if (!name) { saveAsName.focus(); return; }
        if (TEMPLATE_META[name] || name === '__custom__') {
          saveAsName.focus();
          saveAsName.select();
          return;
        }
        const list = loadUserTemplates().filter(t => t.name !== name);
        list.push({ name, scopes: Array.from(selected) });
        saveUserTemplates(list);
        closeSaveAs();
        renderTemplates();
        setActiveTemplate('user:' + name);
        dirty = false;
        updateFooter();
      }

      matrixEl.addEventListener('click', onPillClick);
      searchEl.addEventListener('input', onSearch);
      saveAsOpen.addEventListener('click', openSaveAs);
      saveAsCancel.addEventListener('click', closeSaveAs);
      saveAsConfirm.addEventListener('click', confirmSaveAs);
      saveAsName.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); confirmSaveAs(); }
        if (ev.key === 'Escape') { ev.preventDefault(); closeSaveAs(); }
      });

      renderTemplates();
      applyTemplate(DEFAULT_TEMPLATE || Object.keys(TEMPLATES)[0] || '__custom__');
      onSearch();
    })();
  </script>
</body>
</html>
`

  return new Response(htmlContent, {
    headers: {
      'Content-Security-Policy': "frame-ancestors 'none'",
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': setCookie,
      'X-Frame-Options': 'DENY'
    }
  })
}

/**
 * Result of parsing the approval form submission.
 */
export interface ParsedApprovalResult {
  state: { oauthReqInfo?: AuthRequest }
  headers: Record<string, string>
  selectedScopes?: string[]
  selectedTemplate?: string
}

/**
 * Parses the form submission from the approval dialog.
 */
export async function parseRedirectApproval(
  request: Request,
  cookieSecret: string
): Promise<ParsedApprovalResult> {
  if (request.method !== 'POST') {
    throw new OAuthError('invalid_request', 'Invalid request method', 405)
  }

  const formData = await request.formData()

  // Validate CSRF token
  const tokenFromForm = formData.get('csrf_token')
  if (!tokenFromForm || typeof tokenFromForm !== 'string') {
    throw new OAuthError('invalid_request', 'Missing CSRF token')
  }

  const cookieHeader = request.headers.get('Cookie') || ''
  const cookies = cookieHeader.split(';').map((c) => c.trim())
  const csrfCookie = cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`))
  const tokenFromCookie = csrfCookie ? csrfCookie.substring(CSRF_COOKIE.length + 1) : null

  if (!tokenFromCookie || tokenFromForm !== tokenFromCookie) {
    throw new OAuthError('access_denied', 'CSRF token mismatch', 403)
  }

  const encodedState = formData.get('state')
  if (!encodedState || typeof encodedState !== 'string') {
    throw new OAuthError('invalid_request', 'Missing state')
  }

  const state = JSON.parse(atob(encodedState))
  if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
    throw new OAuthError('invalid_request', 'Invalid state data')
  }

  // Extract selected scopes (from checkboxes) and template
  const selectedScopes = formData.getAll('scopes').filter((s): s is string => typeof s === 'string')
  const selectedTemplate = formData.get('scope_template')

  // Update approved clients cookie
  const existingApprovedClients =
    (await getApprovedClientsFromCookie(request.headers.get('Cookie'), cookieSecret)) || []
  const updatedApprovedClients = Array.from(
    new Set([...existingApprovedClients, state.oauthReqInfo.clientId])
  )

  const payload = JSON.stringify(updatedApprovedClients)
  const key = await importKey(cookieSecret)
  const signature = await signData(key, payload)
  const newCookieValue = `${signature}.${btoa(payload)}`

  return {
    state,
    headers: {
      'Set-Cookie': `${APPROVED_CLIENTS_COOKIE}=${newCookieValue}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${ONE_YEAR_IN_SECONDS}`
    },
    selectedScopes: selectedScopes.length > 0 ? selectedScopes : undefined,
    selectedTemplate: typeof selectedTemplate === 'string' ? selectedTemplate : undefined
  }
}

/**
 * Generate CSRF protection token and cookie
 */
export function generateCSRFProtection(): { token: string; setCookie: string } {
  const token = crypto.randomUUID()
  const setCookie = `${CSRF_COOKIE}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`
  return { token, setCookie }
}

/**
 * Create OAuth state in KV
 */
export async function createOAuthState(
  oauthReqInfo: AuthRequest,
  kv: KVNamespace,
  codeVerifier: string
): Promise<string> {
  const stateToken = crypto.randomUUID()
  await kv.put(`oauth:state:${stateToken}`, JSON.stringify({ oauthReqInfo, codeVerifier }), {
    expirationTtl: 600
  })
  return stateToken
}

/**
 * Bind state token to session via cookie
 */
export async function bindStateToSession(stateToken: string): Promise<{ setCookie: string }> {
  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(stateToken))
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  return {
    setCookie: `${STATE_COOKIE}=${hashHex}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`
  }
}

/**
 * Schema for validating stored OAuth state
 */
const StoredOAuthStateSchema = z.object({
  oauthReqInfo: z
    .object({
      clientId: z.string(),
      scope: z.array(z.string()).optional(),
      state: z.string().optional(),
      responseType: z.string().optional(),
      redirectUri: z.string().optional()
    })
    .passthrough(),
  codeVerifier: z.string().min(1)
})

/**
 * Renders a styled error page matching Cloudflare's design system
 */
export function renderErrorPage(
  title: string,
  message: string,
  details?: string,
  status = 400
): Response {
  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${sanitizeHtml(title)} | Cloudflare</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --cf-orange: #f6821f;
      --cf-orange-hover: #e5750f;
      --cf-text: #313131;
      --cf-text-muted: #707070;
      --cf-text-light: #9c9c9c;
      --cf-bg: #ffffff;
      --cf-bg-muted: #f7f7f7;
      --cf-bg-alt: #fafafa;
      --cf-border: #e5e5e5;
      --cf-border-strong: #d4d4d4;
      --cf-red: #c0392b;
      --cf-red-light: rgba(192, 57, 43, 0.08);
      --border-radius: 8px;
      --border-radius-lg: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      font-feature-settings: 'cv11', 'ss01';
      font-size: 14px;
      line-height: 1.5;
      color: var(--cf-text-default);
      background: var(--cf-canvas);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      padding: 1rem 2rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      border-bottom: 1px solid var(--cf-hairline);
      background: var(--cf-base);
    }
    .cf-logo { display: flex; align-items: center; gap: 0.5rem; text-decoration: none; color: inherit; }
    .cf-logo img { height: 32px; width: auto; }
    .cf-logo-divider { width: 1px; height: 24px; background: var(--cf-interact); margin: 0 0.5rem; }
    .cf-logo-product { font-size: 14px; color: var(--cf-text-subtle); }
    .main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      background: var(--cf-base);
      border: 1px solid var(--cf-hairline);
      border-radius: var(--border-radius-lg);
      width: 100%;
      max-width: 440px;
      overflow: hidden;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
      text-align: center;
      padding: 2.5rem 2rem;
    }
    .error-icon {
      width: 56px;
      height: 56px;
      background: var(--cf-red-light);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
    }
    .error-icon svg { width: 28px; height: 28px; color: var(--cf-red); }
    .card-title {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--cf-text-default);
      margin-bottom: 0.5rem;
    }
    .card-message {
      font-size: 0.95rem;
      color: var(--cf-text-subtle);
      margin-bottom: 1.5rem;
    }
    .error-details {
      background: var(--cf-elevated);
      border: 1px solid var(--cf-hairline);
      border-radius: var(--border-radius);
      padding: 0.75rem 1rem;
      font-family: ui-monospace, 'SF Mono', Menlo, Monaco, 'Courier New', monospace;
      font-size: 0.8rem;
      color: var(--cf-text-subtle);
      text-align: left;
      word-break: break-word;
      margin-bottom: 1.5rem;
    }
    .button {
      display: inline-block;
      padding: 0.55rem 1.25rem;
      border-radius: var(--border-radius);
      font-family: inherit;
      font-size: 0.875rem;
      font-weight: 500;
      text-decoration: none;
      background: var(--cf-brand);
      color: white;
      border: 1px solid var(--cf-brand);
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .button:hover { background: var(--cf-brand-hover); border-color: var(--cf-brand-hover); }
    .footer {
      padding: 1rem 2rem;
      text-align: center;
      font-size: 12px;
      color: var(--cf-text-inactive);
      border-top: 1px solid var(--cf-hairline);
      background: var(--cf-base);
    }
    .footer a { color: var(--cf-text-subtle); text-decoration: none; }
    .footer a:hover { color: var(--cf-brand); }
  </style>
</head>
<body>
  <header class="header">
    <a href="https://cloudflare.com" class="cf-logo">
      <img src="https://www.cloudflare.com/img/logo-cloudflare-dark.svg" alt="Cloudflare" height="32">
    </a>
    <div class="cf-logo-divider"></div>
    <span class="cf-logo-product">MCP Server</span>
  </header>
  <main class="main">
    <div class="card">
      <div class="error-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
      </div>
      <h1 class="card-title">${sanitizeHtml(title)}</h1>
      <p class="card-message">${sanitizeHtml(message)}</p>
      ${details ? `<div class="error-details">${sanitizeHtml(details)}</div>` : ''}
      <a href="javascript:window.close()" class="button" onclick="window.close(); return false;">Close window</a>
    </div>
  </main>
  <footer class="footer">
    <a href="https://cloudflare.com/privacypolicy">Privacy</a> ·
    <a href="https://cloudflare.com/terms">Terms</a> ·
    <a href="https://developers.cloudflare.com">Docs</a>
  </footer>
</body>
</html>
`

  return new Response(htmlContent, {
    status,
    headers: {
      'Content-Security-Policy': "frame-ancestors 'none'",
      'Content-Type': 'text/html; charset=utf-8',
      'X-Frame-Options': 'DENY'
    }
  })
}

/**
 * Validate OAuth state from request
 */
export async function validateOAuthState(
  request: Request,
  kv: KVNamespace
): Promise<{
  oauthReqInfo: AuthRequest
  codeVerifier: string
  clearCookie: string
}> {
  const url = new URL(request.url)
  const stateFromQuery = url.searchParams.get('state')

  if (!stateFromQuery) {
    throw new OAuthError('invalid_request', 'Missing state parameter')
  }

  // Decode state to extract embedded stateToken
  let stateToken: string
  try {
    const decodedState = JSON.parse(atob(stateFromQuery))
    stateToken = decodedState.state
    if (!stateToken) {
      throw new Error('State token not found')
    }
  } catch {
    throw new OAuthError('invalid_request', 'Failed to decode state')
  }

  // Validate state exists in KV
  const storedDataJson = await kv.get(`oauth:state:${stateToken}`)
  if (!storedDataJson) {
    throw new OAuthError('invalid_request', 'Invalid or expired state')
  }

  // Validate session binding cookie
  const cookieHeader = request.headers.get('Cookie') || ''
  const cookies = cookieHeader.split(';').map((c) => c.trim())
  const stateCookie = cookies.find((c) => c.startsWith(`${STATE_COOKIE}=`))
  const stateHash = stateCookie ? stateCookie.substring(STATE_COOKIE.length + 1) : null

  if (!stateHash) {
    throw new OAuthError('invalid_request', 'Missing session binding - restart authorization')
  }

  // Verify hash matches
  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(stateToken))
  const expectedHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  if (stateHash !== expectedHash) {
    throw new OAuthError('invalid_request', 'State mismatch - possible CSRF attack')
  }

  // Parse and validate stored data
  const parseResult = StoredOAuthStateSchema.safeParse(JSON.parse(storedDataJson))
  if (!parseResult.success) {
    throw new OAuthError('server_error', 'Invalid stored state data')
  }

  // Delete state (single use)
  await kv.delete(`oauth:state:${stateToken}`)

  return {
    oauthReqInfo: parseResult.data.oauthReqInfo as AuthRequest,
    codeVerifier: parseResult.data.codeVerifier,
    clearCookie: `${STATE_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`
  }
}

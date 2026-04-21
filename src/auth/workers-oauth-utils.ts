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
 * Turn a resource key like `workers_scripts` into "Workers scripts".
 */
function humanize(key: string): string {
  const spaced = key.replace(/[_-]/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

interface ScopeRow {
  resource: string
  label: string
  actions: Array<{ action: string; scope: string; desc: string; required: boolean }>
}

/**
 * Group scopes by resource (the part before the `:`). A scope without a colon
 * (e.g. `offline_access`) becomes a single-action row.
 */
function groupScopesByResource(
  allScopes: Record<string, string>,
  requiredScopes: Set<string>
): ScopeRow[] {
  const byResource = new Map<string, ScopeRow>()

  for (const [scope, desc] of Object.entries(allScopes)) {
    const [resource, action = 'grant'] = scope.includes(':') ? scope.split(':') : [scope]
    if (!byResource.has(resource)) {
      byResource.set(resource, { resource, label: humanize(resource), actions: [] })
    }
    byResource.get(resource)!.actions.push({
      action,
      scope,
      desc,
      required: requiredScopes.has(scope)
    })
  }

  // Sort actions within a row: read first, then write/edit, then run/admin, then others alphabetically.
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

  // Sort resources: put rows containing required scopes first (Core), then alphabetical.
  return Array.from(byResource.values()).sort((a, b) => {
    const aReq = a.actions.some((x) => x.required) ? 0 : 1
    const bReq = b.actions.some((x) => x.required) ? 0 : 1
    return aReq === bReq ? a.label.localeCompare(b.label) : aReq - bReq
  })
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
  const rows = groupScopesByResource(allScopes, requiredSet)

  const rowsHtml = rows
    .map((row) => {
      const pills = row.actions
        .map((a) => {
          const label = ACTION_LABELS[a.action] ?? humanize(a.action)
          const classes = ['pill', `pill--${a.action}`]
          if (a.required) classes.push('pill--required')
          return `<button type="button" class="${classes.join(' ')}" data-scope="${sanitizeHtml(a.scope)}" data-action="${sanitizeHtml(a.action)}" data-required="${a.required ? '1' : ''}" title="${sanitizeHtml(a.scope)} — ${sanitizeHtml(a.desc)}" aria-pressed="false">${sanitizeHtml(label)}</button>`
        })
        .join('')
      const hasRequired = row.actions.some((a) => a.required)
      return `
        <div class="row" data-resource="${sanitizeHtml(row.resource)}" data-search="${sanitizeHtml((row.label + ' ' + row.resource).toLowerCase())}">
          <div class="row-label">
            <span class="row-name">${sanitizeHtml(row.label)}</span>
            <span class="row-key">${sanitizeHtml(row.resource)}</span>
            ${hasRequired ? '<span class="row-badge">Required</span>' : ''}
          </div>
          <div class="row-pills">${pills}</div>
        </div>`
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
  <title>Authorize ${clientName} · Cloudflare MCP</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --ink: #16110d;
      --ink-soft: #3d342d;
      --ink-muted: #7a6e65;
      --ink-faint: #b3a99f;
      --paper: #faf7f2;
      --paper-2: #f3ede3;
      --paper-3: #ebe3d5;
      --line: rgba(22, 17, 13, 0.08);
      --line-strong: rgba(22, 17, 13, 0.18);
      --accent: #f6821f;
      --accent-ink: #16110d;
      --accent-soft: rgba(246, 130, 31, 0.10);
      --danger: #c02d30;
      --pill-radius: 6px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    html, body { height: 100%; }

    body {
      font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color: var(--ink);
      background: var(--paper);
      background-image:
        radial-gradient(rgba(22, 17, 13, 0.025) 1px, transparent 1px),
        radial-gradient(rgba(22, 17, 13, 0.02) 1px, transparent 1px);
      background-size: 24px 24px, 40px 40px;
      background-position: 0 0, 12px 12px;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .masthead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 32px;
      border-bottom: 1px solid var(--line);
      background: rgba(250, 247, 242, 0.7);
      backdrop-filter: saturate(140%) blur(8px);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .masthead .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: 'Fraunces', serif;
      font-weight: 500;
      font-size: 18px;
      letter-spacing: -0.01em;
    }
    .masthead .brand img { width: 28px; height: 28px; }
    .masthead .brand em {
      font-style: italic;
      font-weight: 400;
      color: var(--ink-muted);
    }
    .masthead .eyebrow {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--ink-muted);
    }

    .frame {
      flex: 1;
      width: 100%;
      max-width: 960px;
      margin: 0 auto;
      padding: 48px 32px 120px;
      display: grid;
      grid-template-columns: 1fr;
      gap: 40px;
    }

    .hero {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 32px;
      align-items: start;
    }
    .hero .num {
      font-family: 'Fraunces', serif;
      font-weight: 400;
      font-style: italic;
      font-size: 56px;
      color: var(--accent);
      line-height: 1;
      padding-top: 6px;
    }
    .hero h1 {
      font-family: 'Fraunces', serif;
      font-weight: 500;
      font-size: 38px;
      line-height: 1.1;
      letter-spacing: -0.02em;
      color: var(--ink);
      margin-bottom: 12px;
    }
    .hero h1 em {
      font-style: italic;
      font-weight: 400;
      color: var(--accent);
    }
    .hero p {
      font-size: 15px;
      color: var(--ink-soft);
      max-width: 52ch;
    }
    .hero .client-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 16px;
      padding: 6px 12px;
      border: 1px solid var(--line-strong);
      border-radius: 100px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--ink-soft);
      background: var(--paper-2);
    }
    .hero .client-pill::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--accent);
    }

    .divider {
      height: 1px;
      background: var(--line);
      position: relative;
    }
    .divider::before {
      content: attr(data-label);
      position: absolute;
      left: 0;
      top: -9px;
      padding-right: 16px;
      background: var(--paper);
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--ink-muted);
    }

    /* Template chooser */
    .templates {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .tmpl {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px 10px 14px;
      border: 1px solid var(--line-strong);
      border-radius: 10px;
      background: var(--paper-2);
      cursor: pointer;
      transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
      font-family: 'IBM Plex Sans', sans-serif;
    }
    .tmpl:hover { border-color: var(--ink); background: var(--paper-3); }
    .tmpl[aria-pressed="true"] {
      border-color: var(--accent);
      background: #fff;
      box-shadow: inset 0 0 0 1px var(--accent);
    }
    .tmpl .tmpl-name {
      font-weight: 500;
      font-size: 14px;
      color: var(--ink);
    }
    .tmpl .tmpl-tag {
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--ink-muted);
      padding: 2px 6px;
      border-radius: 4px;
      background: var(--paper-3);
    }
    .tmpl[aria-pressed="true"] .tmpl-tag { background: var(--accent-soft); color: var(--accent); }
    .tmpl .tmpl-delete {
      margin-left: 4px;
      width: 16px;
      height: 16px;
      border: none;
      background: transparent;
      cursor: pointer;
      color: var(--ink-muted);
      border-radius: 4px;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .tmpl[data-user="1"] .tmpl-delete { display: inline-flex; }
    .tmpl .tmpl-delete:hover { background: rgba(192, 45, 48, 0.12); color: var(--danger); }
    .tmpl--custom {
      border-style: dashed;
      background: transparent;
    }
    .tmpl--custom[aria-pressed="true"] {
      background: #fff;
      border-style: solid;
    }

    /* Matrix */
    .matrix-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
    }
    .search {
      flex: 1;
      position: relative;
    }
    .search input {
      width: 100%;
      padding: 10px 14px 10px 36px;
      border: 1px solid var(--line-strong);
      border-radius: 10px;
      font-family: inherit;
      font-size: 14px;
      background: #fff;
      color: var(--ink);
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    .search input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .search svg {
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      width: 14px;
      height: 14px;
      color: var(--ink-muted);
    }
    .counter {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--ink-muted);
      white-space: nowrap;
    }
    .counter strong { color: var(--ink); font-weight: 500; }
    .counter.warn strong { color: var(--danger); }

    .matrix {
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }

    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 24px;
      align-items: center;
      padding: 14px 4px;
      border-bottom: 1px dashed var(--line);
    }
    .row:last-child { border-bottom: none; }
    .row.hidden { display: none; }

    .row-label { min-width: 0; }
    .row-name {
      font-weight: 500;
      font-size: 14px;
      color: var(--ink);
      display: block;
    }
    .row-key {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--ink-muted);
      letter-spacing: 0.02em;
    }
    .row-badge {
      display: inline-block;
      margin-left: 8px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
      padding: 1px 6px;
      border: 1px solid var(--accent);
      border-radius: 3px;
      vertical-align: 1px;
    }

    .row-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
    }
    .pill {
      font-family: 'IBM Plex Sans', sans-serif;
      font-size: 12px;
      font-weight: 500;
      padding: 6px 12px;
      border: 1px solid var(--line-strong);
      border-radius: var(--pill-radius);
      background: transparent;
      color: var(--ink-soft);
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease, transform 120ms ease;
      min-width: 56px;
      text-align: center;
    }
    .pill:hover { border-color: var(--ink); color: var(--ink); }
    .pill[aria-pressed="true"] {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .pill--required {
      cursor: not-allowed;
    }
    .pill[aria-pressed="true"].pill--required {
      background: var(--accent-ink);
      border-color: var(--accent-ink);
    }
    .pill:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* Footer bar */
    .footbar {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 16px 32px;
      background: rgba(250, 247, 242, 0.92);
      backdrop-filter: saturate(140%) blur(10px);
      border-top: 1px solid var(--line-strong);
      display: flex;
      align-items: center;
      gap: 12px;
      z-index: 20;
    }
    .footbar .summary {
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--ink-muted);
    }
    .footbar .summary strong { color: var(--ink); font-weight: 500; }
    .footbar .spacer { flex: 1; }
    .btn {
      padding: 10px 18px;
      border-radius: 8px;
      border: 1px solid transparent;
      font-family: inherit;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, transform 120ms ease, color 120ms ease;
    }
    .btn-ghost {
      background: transparent;
      color: var(--ink-muted);
    }
    .btn-ghost:hover { color: var(--ink); }
    .btn-outline {
      background: transparent;
      border-color: var(--ink);
      color: var(--ink);
    }
    .btn-outline:hover { background: var(--paper-2); }
    .btn-outline:disabled { border-color: var(--line); color: var(--ink-faint); cursor: not-allowed; background: transparent; }
    .btn-primary {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .btn-primary:hover { transform: translateY(-1px); }
    .btn-primary:disabled { background: var(--line); border-color: var(--line); color: var(--ink-faint); cursor: not-allowed; transform: none; }

    /* Save-as dialog (inline) */
    .save-as {
      display: none;
      align-items: center;
      gap: 8px;
    }
    .save-as.open { display: inline-flex; }
    .save-as input {
      padding: 8px 12px;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      font-family: inherit;
      font-size: 13px;
      outline: none;
      background: #fff;
      min-width: 200px;
    }
    .save-as input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

    .colophon {
      margin-top: 40px;
      padding-top: 24px;
      border-top: 1px solid var(--line);
      display: flex;
      align-items: center;
      gap: 10px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--ink-muted);
    }
    .colophon a {
      color: var(--ink-muted);
      text-decoration: none;
      transition: color 120ms ease;
    }
    .colophon a:hover { color: var(--accent); }
    .colophon .dot { color: var(--ink-faint); }

    @media (max-width: 680px) {
      .frame { padding: 32px 20px 160px; gap: 32px; }
      .hero { grid-template-columns: 1fr; gap: 8px; }
      .hero .num { font-size: 44px; padding-top: 0; }
      .hero h1 { font-size: 30px; }
      .matrix-head { flex-direction: column; align-items: stretch; }
      .row { grid-template-columns: 1fr; gap: 10px; }
      .row-pills { justify-content: flex-start; }
      .footbar { padding: 12px 16px; flex-wrap: wrap; gap: 8px; }
      .footbar .summary { order: -1; width: 100%; }
    }

    @keyframes flash {
      0% { background: var(--accent-soft); }
      100% { background: transparent; }
    }
    .row.flash { animation: flash 600ms ease; }
  </style>
</head>
<body>
  <header class="masthead">
    <div class="brand">
      <img src="https://www.cloudflare.com/favicon.ico" alt="">
      <span>Cloudflare <em>MCP</em></span>
    </div>
    <div class="eyebrow">Authorize access</div>
  </header>

  <main class="frame">
    <section class="hero">
      <div class="num">§</div>
      <div>
        <h1>Grant <em>${clientName}</em> access to your Cloudflare account</h1>
        <p>Pick a template or fine-tune individual permissions. You'll sign in to Cloudflare on the next step to confirm.</p>
        <div class="client-pill">Requesting app · ${clientName}</div>
      </div>
    </section>

    <form method="post" action="${new URL(request.url).pathname}" id="authForm">
      <input type="hidden" name="state" value="${encodedState}">
      <input type="hidden" name="csrf_token" value="${csrfToken}">
      <div id="hiddenScopes"></div>

      <section>
        <div class="divider" data-label="Templates" style="margin-bottom: 20px;"></div>
        <div class="templates" id="templates" role="radiogroup" aria-label="Permission templates"></div>
      </section>

      <section style="margin-top: 32px;">
        <div class="divider" data-label="Permissions" style="margin-bottom: 20px;"></div>
        <div class="matrix-head">
          <div class="search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>
            </svg>
            <input type="search" id="search" placeholder="Filter by resource (e.g. workers, dns, ai)" autocomplete="off">
          </div>
          <div class="counter" id="counter"><strong>0</strong> / ${maxScopes ?? Object.keys(allScopes).length} scopes</div>
        </div>
        <div class="matrix" id="matrix">
          ${rowsHtml}
        </div>
      </section>
    </form>

    <footer class="colophon">
      <span>Cloudflare MCP</span>
      <span class="dot">·</span>
      <a href="https://cloudflare.com/privacypolicy" target="_blank" rel="noopener">Privacy</a>
      <span class="dot">·</span>
      <a href="https://cloudflare.com/terms" target="_blank" rel="noopener">Terms</a>
      <span class="dot">·</span>
      <a href="https://developers.cloudflare.com" target="_blank" rel="noopener">Docs</a>
    </footer>
  </main>

  <div class="footbar">
    <div class="summary" id="summary">No changes yet</div>
    <div class="spacer"></div>

    <div class="save-as" id="saveAs">
      <input type="text" id="saveAsName" placeholder="Template name" maxlength="40">
      <button type="button" class="btn btn-outline" id="saveAsConfirm">Save</button>
      <button type="button" class="btn btn-ghost" id="saveAsCancel">Cancel</button>
    </div>

    <button type="button" class="btn btn-outline" id="saveAsOpen" disabled>Save as template</button>
    <button type="button" class="btn btn-ghost" onclick="window.close()">Cancel</button>
    <button type="submit" class="btn btn-primary" id="continueBtn" form="authForm">Continue</button>
  </div>

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
      const summaryEl = document.getElementById('summary');
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

      function renderTemplates() {
        const user = loadUserTemplates();
        const entries = [];
        for (const [key, meta] of Object.entries(TEMPLATE_META)) {
          entries.push({ key, name: meta.name, tagline: meta.tagline, user: false });
        }
        for (const t of user) {
          entries.push({ key: 'user:' + t.name, name: t.name, tagline: 'Yours', user: true });
        }
        entries.push({ key: '__custom__', name: 'Custom', tagline: '', user: false, custom: true });

        templatesEl.innerHTML = entries.map(e => {
          const classes = ['tmpl'];
          if (e.custom) classes.push('tmpl--custom');
          return \`
            <button type="button" class="\${classes.join(' ')}" data-key="\${e.key}" data-user="\${e.user ? '1' : ''}" aria-pressed="false" role="radio">
              <span class="tmpl-name">\${escapeHtml(e.name)}</span>
              \${e.tagline ? '<span class="tmpl-tag">' + escapeHtml(e.tagline) + '</span>' : ''}
              \${e.user ? '<button type="button" class="tmpl-delete" data-delete="' + escapeHtml(e.key) + '" aria-label="Delete template" title="Delete"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>' : ''}
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
        templatesEl.querySelectorAll('[data-delete]').forEach(btn => {
          btn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const key = btn.dataset.delete;
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

      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
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
          const isSelected = selected.has(scope);
          pill.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        });
        enforceLimit();
        updateCounter();
        renderHiddenInputs();
      }

      function enforceLimit() {
        if (!MAX_SCOPES) return;
        const atMax = selected.size >= MAX_SCOPES;
        matrixEl.querySelectorAll('.pill').forEach(pill => {
          if (pill.dataset.required) return;
          const scope = pill.dataset.scope;
          if (!selected.has(scope)) {
            pill.disabled = atMax;
          } else {
            pill.disabled = false;
          }
        });
      }

      function updateCounter() {
        const count = selected.size;
        const max = MAX_SCOPES || ALL_SCOPES.size;
        counterEl.innerHTML = '<strong>' + count + '</strong> / ' + max + ' scopes';
        counterEl.classList.toggle('warn', MAX_SCOPES > 0 && count >= MAX_SCOPES);
      }

      function updateFooter() {
        const count = selected.size;
        if (!dirty && activeTemplate && activeTemplate !== '__custom__') {
          const meta = TEMPLATE_META[activeTemplate] || { name: activeTemplate.replace(/^user:/, '') };
          summaryEl.innerHTML = 'Using <strong>' + escapeHtml(meta.name) + '</strong> · ' + count + ' scopes';
          saveAsOpen.disabled = true;
        } else if (count === 0) {
          summaryEl.textContent = 'No scopes selected';
          saveAsOpen.disabled = true;
        } else {
          summaryEl.innerHTML = '<strong>Custom</strong> · ' + count + ' scopes';
          saveAsOpen.disabled = false;
        }
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

      // Wire up
      matrixEl.addEventListener('click', onPillClick);
      searchEl.addEventListener('input', onSearch);
      saveAsOpen.addEventListener('click', openSaveAs);
      saveAsCancel.addEventListener('click', closeSaveAs);
      saveAsConfirm.addEventListener('click', confirmSaveAs);
      saveAsName.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); confirmSaveAs(); }
        if (ev.key === 'Escape') { ev.preventDefault(); closeSaveAs(); }
      });

      // Boot
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
  <title>${sanitizeHtml(title)} · Cloudflare MCP</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500&family=IBM+Plex+Sans:wght@400;500&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
  <style>
    :root {
      --ink: #16110d;
      --ink-soft: #3d342d;
      --ink-muted: #7a6e65;
      --paper: #faf7f2;
      --paper-2: #f3ede3;
      --line: rgba(22, 17, 13, 0.08);
      --accent: #f6821f;
      --danger: #c02d30;
      --danger-soft: rgba(192, 45, 48, 0.08);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      line-height: 1.5;
      color: var(--ink);
      background: var(--paper);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .masthead {
      padding: 20px 32px;
      display: flex;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid var(--line);
    }
    .masthead .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-family: 'Fraunces', serif;
      font-weight: 500;
      font-size: 18px;
    }
    .masthead img { width: 24px; height: 24px; }
    .main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px 24px;
    }
    .card {
      max-width: 480px;
      text-align: center;
    }
    .mark {
      display: inline-flex;
      width: 64px;
      height: 64px;
      background: var(--danger-soft);
      border-radius: 50%;
      align-items: center;
      justify-content: center;
      margin-bottom: 24px;
    }
    .mark svg { width: 28px; height: 28px; color: var(--danger); }
    h1 {
      font-family: 'Fraunces', serif;
      font-weight: 500;
      font-size: 32px;
      line-height: 1.15;
      letter-spacing: -0.015em;
      margin-bottom: 12px;
    }
    p.msg {
      font-size: 15px;
      color: var(--ink-soft);
      margin-bottom: 24px;
    }
    .details {
      background: var(--paper-2);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px 16px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: var(--ink-muted);
      text-align: left;
      word-break: break-word;
      margin-bottom: 24px;
    }
    .btn {
      display: inline-block;
      padding: 10px 22px;
      border-radius: 8px;
      font-family: inherit;
      font-size: 14px;
      font-weight: 500;
      text-decoration: none;
      background: var(--accent);
      color: #fff;
      border: 1px solid var(--accent);
      cursor: pointer;
    }
    .btn:hover { transform: translateY(-1px); }
  </style>
</head>
<body>
  <header class="masthead">
    <div class="brand">
      <img src="https://www.cloudflare.com/favicon.ico" alt="">
      <span>Cloudflare MCP</span>
    </div>
  </header>
  <main class="main">
    <div class="card">
      <div class="mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
      </div>
      <h1>${sanitizeHtml(title)}</h1>
      <p class="msg">${sanitizeHtml(message)}</p>
      ${details ? `<div class="details">${sanitizeHtml(details)}</div>` : ''}
      <a href="javascript:window.close()" class="btn" onclick="window.close(); return false;">Close window</a>
    </div>
  </main>
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

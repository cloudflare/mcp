import { z } from 'zod'

import {
  OAuthError as ProviderOAuthError,
  type AuthRequest,
  type ClientInfo
} from '@cloudflare/workers-oauth-provider'

const CSRF_COOKIE = '__Host-CSRF_TOKEN'
const STATE_COOKIE = '__Host-CONSENTED_STATE'
const OAuthStateToken = z.uuid()
const LegacyOAuthState = z.object({ state: OAuthStateToken }).passthrough()
const MAX_LEGACY_OAUTH_STATE_LENGTH = 32_768

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value)
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

function parseOAuthStateToken(state: string): string | undefined {
  const current = OAuthStateToken.safeParse(state)
  if (current.success) return current.data

  // TODO: Remove this legacy base64-JSON reader after all OAuth flows started
  // before the opaque-state deployment have exceeded the 600-second KV TTL.
  if (state.length > MAX_LEGACY_OAUTH_STATE_LENGTH) return undefined
  try {
    const legacy = LegacyOAuthState.safeParse(JSON.parse(atob(state)))
    return legacy.success ? legacy.data.state : undefined
  } catch {
    return undefined
  }
}

/**
 * OAuth error class for handling OAuth-specific errors
 */
export class OAuthError extends ProviderOAuthError {
  constructor(
    code: string,
    description: string,
    statusCode = 400,
    headers: Record<string, string> = {}
  ) {
    super(code, { description, statusCode, headers })
  }

  toResponse(): Response {
    return new Response(
      JSON.stringify({
        error: this.code,
        error_description: this.description
      }),
      {
        status: this.statusCode,
        headers: { 'Content-Type': 'application/json', ...this.headers }
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
    const response = renderErrorPage(
      title,
      this.description,
      `Error code: ${this.code}`,
      this.statusCode
    )
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(this.headers ?? {})) headers.set(name, value)
    return new Response(response.body, { status: response.status, headers })
  }
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

export interface ScopeDefinition {
  name: string
  category: string
}

/**
 * Configuration for the approval dialog
 */
export interface ApprovalDialogOptions {
  client: ClientInfo | null
  redirectUri: string
  server: {
    name: string
    logo?: string
    description?: string
  }
  state: Record<string, unknown>
  csrfToken: string
  setCookie: string
  scopeTemplates: Record<string, ScopeTemplate>
  scopeDefinitions: Record<string, ScopeDefinition>
  defaultTemplate: string
  requiredScopes: readonly string[]
  initialScopes: readonly string[]
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
 * Render a URL as the browser parsed it, without credentials or a fragment.
 * The host keeps the default text colour and the scheme and path are dimmed,
 * so the destination stays easy to spot in a long URL.
 */
function renderDisplayUrl(
  value: string,
  options: { readonly requireHttps: boolean } = { requireHttps: false }
): string | undefined {
  try {
    const url = new URL(value)
    if (!url.hostname) return undefined
    if (options.requireHttps && url.protocol !== 'https:') return undefined
    // Let long URLs wrap after a slash rather than mid-word on narrow screens.
    const rest = sanitizeHtml(url.pathname + url.search).replace(/\//g, '/<wbr>')
    return `<span class="client-detail-url"><span class="url-dim">${sanitizeHtml(url.protocol)}//</span>${sanitizeHtml(url.host)}<span class="url-dim">${rest}</span></span>`
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true

  const octets = normalized.split('.')
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  )
}

/**
 * MCP requires authorization redirects to use HTTPS, except for loopback
 * callbacks used by native clients. Reject URL features that make the
 * destination ambiguous or are forbidden for OAuth redirect endpoints.
 */
export function isAllowedOAuthRedirectUri(value: string): boolean {
  if (value !== value.trim()) return false

  try {
    const url = new URL(value)
    if (!url.hostname || url.username || url.password || url.hash) return false
    if (url.protocol === 'https:') return true
    return url.protocol === 'http:' && isLoopbackHostname(url.hostname)
  } catch {
    return false
  }
}

function isLoopbackRedirectUri(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && isLoopbackHostname(url.hostname)
  } catch {
    return false
  }
}

/**
 * Renders an approval dialog for OAuth authorization with access templates.
 * Users choose individual scopes on Cloudflare's authorization screen.
 */
export function renderApprovalDialog(request: Request, options: ApprovalDialogOptions): Response {
  const {
    client,
    redirectUri,
    state,
    csrfToken,
    setCookie,
    scopeTemplates,
    scopeDefinitions,
    defaultTemplate,
    requiredScopes,
    initialScopes
  } = options

  const encodedState = encodeBase64Utf8(JSON.stringify(state))
  const clientName = client?.clientName ? sanitizeHtml(client.clientName) : 'Unknown MCP Client'
  const redirectUrl = renderDisplayUrl(redirectUri)
  if (!redirectUrl) {
    throw new OAuthError('invalid_request', 'Redirect URI must include a hostname')
  }
  const clientIdUrl = client ? renderDisplayUrl(client.clientId, { requireHttps: true }) : undefined
  const isLocalRedirect = isLoopbackRedirectUri(redirectUri)
  const requiredSet = new Set(requiredScopes)

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
      --cf-interact: #d4d4d4;         /* neutral-300 oklch(87% 0 0)    */
      --cf-contrast: #262626;         /* kumo-contrast (checked state) */
      --cf-text-default: #262626;     /* neutral-900 oklch(21% ...)    */
      --cf-text-subtle: #808080;      /* neutral-500 oklch(55.6% 0 0)  */
      --cf-text-inactive: #a3a3a3;    /* neutral-400 oklch(70.8% 0 0)  */
      --cf-info: #2b7fff;             /* kumo-info (blue-500)          */
      --cf-info-tint: rgba(219, 234, 254, 0.45); /* kumo-info-tint oklch(93.2% 0.032 255.6 / 0.45) */
      --cf-info-text: #193cb8;        /* text-kumo-info (blue-800)     */
      --cf-red: #c0392b;
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
      flex-direction: column;
      align-items: center;
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

    /* Client identity */
    .client-identity { margin-bottom: 1.5rem; }
    .client-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--cf-elevated);
      padding: 0.45rem 0.85rem;
      border-radius: var(--border-radius);
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 0.75rem;
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
    .client-details {
      border: 1px solid var(--cf-hairline);
      border-radius: var(--border-radius);
      background: var(--cf-elevated);
      overflow: hidden;
    }
    .client-detail {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.55rem 0.85rem;
    }
    .client-detail + .client-detail { border-top: 1px solid var(--cf-hairline); }
    .client-detail-label { flex-shrink: 0; color: var(--cf-text-subtle); }
    /* Kumo body text for URLs: the host in the default colour, the rest subtle. */
    .client-detail-url {
      min-width: 0;
      color: var(--cf-text-default);
      overflow-wrap: anywhere;
      text-align: right;
    }
    .url-dim { color: var(--cf-text-subtle); }
    .local-redirect-warning {
      margin-top: 0.75rem;
      padding: 0.75rem 0.85rem;
      border: 1px solid var(--cf-orange);
      border-radius: var(--border-radius);
      background: rgba(246, 130, 31, 0.08);
      color: var(--cf-text-default);
      font-size: 13px;
      line-height: 1.45;
    }

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
    /* Kumo Field description: text-sm leading-snug text-kumo-subtle */
    .section-help {
      margin-top: 0.5rem;
      font-size: 13px;
      line-height: 1.375;
      color: var(--cf-text-subtle);
    }

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

    /* Kumo Banner (variant="default", size="sm"):
       bg-kumo-info-tint text-kumo-info items-center gap-2 rounded-md px-3 py-2 text-sm */
    .banner {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      max-width: 640px;
      margin-bottom: 0.75rem;
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      background: var(--cf-info-tint);
      color: var(--cf-info-text);
      font-size: 13px;
    }
    .banner-icon {
      display: flex;
      flex-shrink: 0;
      align-items: center;
      height: 1.25em;
      fill: var(--cf-info);
    }
    .banner-icon svg { width: 1em; height: 1em; }
    .banner-text {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      column-gap: 0.375rem;
      min-width: 0;
      line-height: 1.375;
    }
    .banner-title { font-weight: 500; }

    /* Actions */
    .actions {
      display: flex;
      justify-content: flex-end;
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
    .button-primary { background: var(--cf-brand); color: white; border-color: var(--cf-brand); min-width: 200px; }
    .button-primary:hover { background: var(--cf-brand-hover); border-color: var(--cf-brand-hover); }
    .button-primary:disabled { background: var(--cf-tint); border-color: var(--cf-hairline); color: var(--cf-text-inactive); cursor: not-allowed; }
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
    <div class="banner">
      <span class="banner-icon" aria-hidden="true">
        <svg viewBox="0 0 256 256"><path d="M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm-4,48a12,12,0,1,1-12,12A12,12,0,0,1,124,72Zm12,112a16,16,0,0,1-16-16V128a8,8,0,0,1,0-16,16,16,0,0,1,16,16v40a8,8,0,0,1,0,16Z"/></svg>
      </span>
      <p class="banner-text">
        <span class="banner-title">Permissions have moved.</span>
        <span class="banner-description">Choose them on the Cloudflare authorization screen.</span>
      </p>
    </div>

    <div class="card">
      <div class="card-header">
        <h1 class="card-title">Authorize Application</h1>
        <p class="card-subtitle">Grant access to Cloudflare API</p>
      </div>

      <div class="card-body">
        <div class="client-identity">
          <div class="client-badge">
            <span class="client-badge-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
            </span>
            ${clientName}
          </div>
          <div class="client-details" aria-label="OAuth client identity and redirect destination">
            ${
              clientIdUrl
                ? `<div class="client-detail">
              <span class="client-detail-label">Client ID</span>
              ${clientIdUrl}
            </div>`
                : ''
            }
            <div class="client-detail">
              <span class="client-detail-label">Redirect URI</span>
              ${redirectUrl}
            </div>
          </div>
          ${
            isLocalRedirect
              ? `<div class="local-redirect-warning" role="alert">
            Local redirect: this client will receive the authorization code on this device. Only continue if you trust the application that opened this page.
          </div>`
              : ''
          }
        </div>

        <form method="post" action="${new URL(request.url).pathname}" id="authForm">
          <input type="hidden" name="state" value="${encodedState}">
          <input type="hidden" name="csrf_token" value="${csrfToken}">
          <div id="hiddenScopes"></div>

          <div class="section">
            <div class="section-label">Access template</div>
            <div class="templates" id="templates" role="radiogroup" aria-label="Permission templates"></div>
            <p class="section-help">Choose Full access if the application needs to make changes. You can narrow permissions further on the Cloudflare authorization screen.</p>
          </div>

          <div class="actions">
            <button type="button" class="button button-ghost" onclick="window.close()">Cancel</button>
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
      const INITIAL_SCOPES = ${JSON.stringify(initialScopes)};
      const REQUIRED = new Set(${JSON.stringify(Array.from(requiredSet))});
      const ALL_SCOPES = new Set(${JSON.stringify(Object.keys(scopeDefinitions))});
      const LS_KEY = 'cf-mcp-consent:user-templates:v1';

      const selected = new Set();
      let activeTemplate = null;
      // "Custom" restores the scopes the client requested. It only appears
      // when those scopes match no template.
      let showCustom = false;

      const templatesEl = document.getElementById('templates');
      const hiddenScopesEl = document.getElementById('hiddenScopes');
      const continueBtn = document.getElementById('continueBtn');

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
        if (showCustom) {
          entries.push({ key: '__custom__', name: 'Custom', tagline: '', user: false, custom: true });
        }

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
            applyTemplate(btn.dataset.key);
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
        if (key === '__custom__') return INITIAL_SCOPES;
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
        if (!scopes) return;
        selected.clear();
        for (const s of scopes) if (ALL_SCOPES.has(s)) selected.add(s);
        for (const r of REQUIRED) selected.add(r);
        activeTemplate = key;
        updateActiveTemplateUI();
        renderHiddenInputs();
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
        continueBtn.disabled = selected.size === 0;
      }

      for (const scope of INITIAL_SCOPES) if (ALL_SCOPES.has(scope)) selected.add(scope);
      for (const scope of REQUIRED) selected.add(scope);
      activeTemplate = matchesExistingTemplate() || '__custom__';
      showCustom = activeTemplate === '__custom__';
      renderTemplates();
      updateActiveTemplateUI();
      renderHiddenInputs();
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
  selectedScopes?: string[]
  selectedTemplate?: string
}

/**
 * Parses the form submission from the approval dialog.
 */
export async function parseRedirectApproval(request: Request): Promise<ParsedApprovalResult> {
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

  const state = JSON.parse(decodeBase64Utf8(encodedState))
  if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
    throw new OAuthError('invalid_request', 'Invalid state data')
  }

  // Extract selected scopes (from checkboxes) and template
  const selectedScopes = formData.getAll('scopes').filter((s): s is string => typeof s === 'string')
  const selectedTemplate = formData.get('scope_template')

  return {
    state,
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

  const stateToken = parseOAuthStateToken(stateFromQuery)
  if (!stateToken) {
    throw new OAuthError('invalid_request', 'Invalid state parameter')
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

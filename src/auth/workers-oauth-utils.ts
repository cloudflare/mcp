import { z } from 'zod'

import {
  OAuthError as ProviderOAuthError,
  type AuthRequest,
  type ClientInfo
} from '@cloudflare/workers-oauth-provider'

import type { ScopeTemplate } from './scopes'

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
 * Kumo's stacked Cloudflare logo with the current brand cloud colours. The
 * wordmark uses `currentColor`, so it follows the text colour in dark mode.
 */
const CLOUDFLARE_LOGO_SVG = `<svg viewBox="0 0 425.6 143.63" role="img" aria-label="Cloudflare"><path fill="#ff5e1f" d="M360.8,90.69l1-3.6c1.24-4.28.78-8.24-1.3-11.15a11.32,11.32,0,0,0-9-4.43l-73.35-.94a1.49,1.49,0,0,1-1.16-.61,1.51,1.51,0,0,1-.15-1.33,2,2,0,0,1,1.7-1.3l74-.94c8.78-.4,18.29-7.53,21.62-16.22l4.22-11a2.51,2.51,0,0,0,.16-.94,2.35,2.35,0,0,0-.05-.52,48.21,48.21,0,0,0-92.7-5,21.69,21.69,0,0,0-34.58,15.15,22,22,0,0,0,.56,7.59,30.83,30.83,0,0,0-29.93,30.82,31.22,31.22,0,0,0,.32,4.46A1.44,1.44,0,0,0,223.68,92H359.13A1.79,1.79,0,0,0,360.8,90.69Z"/><path fill="#ff9911" d="M385.24,40c-.68,0-1.36,0-2,0a1.55,1.55,0,0,0-.31.07,1.14,1.14,0,0,0-.74.78l-2.89,10c-1.24,4.28-.77,8.24,1.31,11.14a11.3,11.3,0,0,0,9,4.44l15.63.94a1.44,1.44,0,0,1,1.12.6,1.5,1.5,0,0,1,.16,1.34,2,2,0,0,1-1.7,1.3l-16.24.94c-8.82.4-18.33,7.52-21.66,16.21l-1.17,3.07a.87.87,0,0,0,.77,1.18h55.94a1.49,1.49,0,0,0,1.45-1.07A40.15,40.15,0,0,0,385.24,40Z"/><path fill="currentColor" d="M47.34 108.53 L56.88 108.53 L56.88 134.59 L73.54 134.59 L73.54 142.94 L47.34 142.94 L47.34 108.53M83.42,125.84v-.10c0-9.88,8-17.9,18.58-17.9s18.48,7.92,18.48,17.8v.1c0,9.88-8,17.89-18.58,17.89s-18.48-7.91-18.48-17.79m27.33,0v-.1c0-5-3.59-9.29-8.85-9.29s-8.7,4.23-8.7,9.19v.1c0,5,3.59,9.29,8.8,9.29s8.75-4.23,8.75-9.19M132.15,127.85V108.53h9.69v19.13c0,5,2.51,7.32,6.34,7.32s6.34-2.26,6.34-7.08V108.53h9.69v19.08c0,11.11-6.34,16-16.13,16s-15.93-5-15.93-15.73M178.8,108.53h13.27c12.29,0,19.42,7.08,19.42,17v.1c0,9.93-7.22,17.3-19.61,17.3H178.8Zm13.42,26c5.71,0,9.49-3.15,9.49-8.7v-.1c0-5.51-3.78-8.7-9.49-8.7h-3.88v17.5ZM225.35 108.53 L252.88 108.53 L252.88 116.89 L234.89 116.89 L234.89 122.74 L251.16 122.74 L251.16 130.65 L234.89 130.65 L234.89 142.94 L225.35 142.94 L225.35 108.53M266.15 108.53 L275.69 108.53 L275.69 134.59 L292.35 134.59 L292.35 142.94 L266.15 142.94 L266.15 108.53M317.27,108.29h9.19l14.65,34.65H330.89l-2.51-6.14H315.11l-2.46,6.14h-10Zm8.36,21.09-3.84-9.79-3.88,9.79ZM353.4,108.53h16.27c5.26,0,8.89,1.38,11.21,3.74a10.69,10.69,0,0,1,3,8v.1A10.89,10.89,0,0,1,376.85,131l8.21,12H374l-6.93-10.42h-4.18v10.42H353.4Zm15.83,16.52c3.24,0,5.11-1.57,5.11-4.08v-.1c0-2.7-2-4.08-5.16-4.08h-6.25v8.26ZM397.68 108.53 L425.36 108.53 L425.36 116.64 L407.12 116.64 L407.12 121.85 L423.64 121.85 L423.64 129.38 L407.12 129.38 L407.12 134.83 L425.61 134.83 L425.61 142.94 L397.68 142.94 L397.68 108.53M26.46,129.87A8.44,8.44,0,0,1,18.58,135c-5.21,0-8.8-4.33-8.8-9.29v-.1c0-5,3.49-9.19,8.7-9.19a8.63,8.63,0,0,1,8.18,5.7H36.72c-1.61-8.19-8.81-14.31-18.14-14.31C8,107.84,0,115.86,0,125.74v.09c0,9.89,7.86,17.8,18.48,17.8,9.08,0,16.18-5.88,18.05-13.76Z"/></svg>`

/** Font links shared by the consent and error pages. The dashboard uses Inter. */
const PAGE_FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">`

/**
 * Kumo 2.14 colour tokens for light and dark mode, resolved from
 * `@cloudflare/kumo/styles` so these standalone pages match the dashboard, plus
 * the page chrome shared by the consent and error pages. The brand accent is
 * Cloudflare's Aerospace Orange, the colour the marketing site and dashboard
 * use for filled brand surfaces.
 */
const PAGE_CHROME_CSS = `
    :root {
      color-scheme: light dark;
      --kumo-canvas: light-dark(oklch(98.75% 0 0), oklch(10% 0 0));
      --kumo-elevated: light-dark(oklch(98% 0 0), oklch(12% 0 0));
      --kumo-base: light-dark(#fff, oklch(17% 0 0));
      --kumo-tint: light-dark(oklch(97% 0 0), oklch(26.9% 0 0));
      --kumo-contrast: light-dark(oklch(12% 0 0), oklch(98.5% 0 0));
      --kumo-interact: light-dark(oklch(87% 0 0), oklch(37.1% 0 0));
      --kumo-line: light-dark(oklch(14.5% 0 0 / 0.1), oklch(32% 0 0));
      --kumo-hairline: light-dark(oklch(93.5% 0 0), oklch(26.9% 0 0));
      --kumo-text-default: light-dark(oklch(20.5% 0 0), oklch(97% 0 0));
      --kumo-text-subtle: light-dark(oklch(55.6% 0 0), oklch(70.8% 0 0));
      --kumo-warning: light-dark(oklch(73.9% 0.177 58.2), oklch(64.5% 0.168 50));
      --kumo-warning-tint: light-dark(oklch(93.1% 0.107 94.6 / 0.2), oklch(35.3% 0.079 65 / 0.37));
      --kumo-text-warning: light-dark(oklch(59.7% 0.144 57.5), oklch(75% 0.183 55.934));
      --kumo-danger: light-dark(oklch(63.7% 0.237 25.331), oklch(57.7% 0.245 27.325));
      --kumo-danger-tint: light-dark(oklch(93.6% 0.032 17.7 / 0.42), oklch(42.9% 0.176 28.7 / 0.17));
      --kumo-shadow-xs: 0 1px 2px 0 rgb(0 0 0 / 0.05);
      --brand: #ff5e1f;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      background: var(--kumo-canvas);
      color: var(--kumo-text-default);
      font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 1rem 2rem;
      background: var(--kumo-base);
      border-bottom: 1px solid var(--kumo-line);
    }
    .cf-logo { display: flex; color: var(--kumo-text-default); }
    .cf-logo svg { width: auto; height: 32px; }
    .cf-logo-divider { width: 1px; height: 24px; margin: 0 0.5rem; background: var(--kumo-line); }
    .cf-logo-product { color: var(--kumo-text-subtle); }
    .main { flex: 1; display: flex; align-items: flex-start; justify-content: center; padding: 2rem; }
    /* Kumo surface: rounded-lg bg-kumo-base shadow-xs ring ring-kumo-line */
    .card {
      width: 100%;
      max-width: 640px;
      overflow: hidden;
      border-radius: 8px;
      background: var(--kumo-base);
      box-shadow: 0 0 0 1px var(--kumo-line), var(--kumo-shadow-xs);
    }
    /* Kumo Button size="base": h-9 px-3 rounded-lg text-base font-medium shadow-xs */
    .button {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 36px;
      padding: 0 0.75rem;
      overflow: hidden;
      border: 0;
      border-radius: 8px;
      font: inherit;
      font-weight: 500;
      text-decoration: none;
      cursor: pointer;
      user-select: none;
    }
    .button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
    .button:disabled { cursor: not-allowed; opacity: 0.5; }
    .button-secondary {
      background: var(--kumo-base);
      color: var(--kumo-text-default);
      box-shadow: 0 0 0 1px var(--kumo-line), var(--kumo-shadow-xs);
    }
    .button-secondary:hover:not(:disabled) { background: var(--kumo-tint); }
    /* Kumo Button variant="primary" with the brand accent as its emphasis colour */
    .button-primary {
      color: #fff;
      background: color-mix(in oklch, var(--brand), white 30%);
      box-shadow: 0 0 0 1px color-mix(in oklch, var(--brand), black 10%), var(--kumo-shadow-xs);
    }
    .button-primary::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: linear-gradient(color-mix(in oklch, var(--brand), white 15%), var(--brand));
      box-shadow: inset 0 1px 0 0 color-mix(in oklch, var(--brand), white 30%);
    }
    .button-primary:hover:not(:disabled)::before {
      background: linear-gradient(color-mix(in oklch, var(--brand), white 30%), var(--brand));
    }
    .button-label { position: relative; }
    .footer {
      padding: 1rem 2rem;
      background: var(--kumo-base);
      border-top: 1px solid var(--kumo-line);
      color: var(--kumo-text-subtle);
      font-size: 12px;
      text-align: center;
    }
    .footer a { color: inherit; text-decoration: none; }
    .footer a:hover { color: var(--kumo-text-default); text-decoration: underline; }`

/** Header shared by the consent and error pages. */
const PAGE_HEADER_HTML = `<header class="header">
    <a href="https://cloudflare.com" class="cf-logo">${CLOUDFLARE_LOGO_SVG}</a>
    <div class="cf-logo-divider"></div>
    <span class="cf-logo-product">MCP Server</span>
  </header>`

/** Footer shared by the consent and error pages. */
const PAGE_FOOTER_HTML = `<footer class="footer">
    <a href="https://cloudflare.com/privacypolicy">Privacy</a> ·
    <a href="https://cloudflare.com/terms">Terms</a> ·
    <a href="https://developers.cloudflare.com">Docs</a>
  </footer>`

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

  const templateLabelsJson = JSON.stringify(
    Object.fromEntries(
      Object.entries(scopeTemplates).map(([k, v]) => [
        k,
        { name: v.name, description: v.description }
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
  ${PAGE_FONT_LINKS}
  <style>${PAGE_CHROME_CSS}
    .card-header { padding: 1.5rem 2rem; border-bottom: 1px solid var(--kumo-line); text-align: center; }
    /* Kumo Text variant="heading" size="lg" */
    .card-title { font-size: 20px; font-weight: 600; line-height: 1.4; }
    .card-subtitle { margin-top: 0.25rem; color: var(--kumo-text-subtle); font-size: 13px; }
    .card-body { padding: 1.5rem 2rem; }

    /* Client identity */
    .client-identity { display: flex; flex-direction: column; align-items: flex-start; gap: 0.75rem; margin-bottom: 1.5rem; }
    .client-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.45rem 0.85rem;
      border-radius: 8px;
      background: var(--kumo-elevated);
      box-shadow: 0 0 0 1px var(--kumo-hairline);
      font-weight: 500;
    }
    .client-badge-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border-radius: 4px;
      background: var(--brand);
    }
    .client-badge-icon svg { width: 12px; height: 12px; }
    .client-details {
      align-self: stretch;
      overflow: hidden;
      border-radius: 8px;
      background: var(--kumo-elevated);
      box-shadow: 0 0 0 1px var(--kumo-hairline);
      font-size: 13px;
    }
    .client-detail { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; padding: 0.55rem 0.85rem; }
    .client-detail + .client-detail { border-top: 1px solid var(--kumo-hairline); }
    .client-detail-label { flex-shrink: 0; color: var(--kumo-text-subtle); }
    .client-detail-url { min-width: 0; overflow-wrap: anywhere; text-align: right; }
    .url-dim { color: var(--kumo-text-subtle); }
    /* Kumo Banner variant="alert": bg-kumo-warning-tint text-kumo-warning */
    .banner-alert {
      align-self: stretch;
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      background: var(--kumo-warning-tint);
      color: var(--kumo-text-warning);
    }
    .banner-icon { display: flex; flex-shrink: 0; align-items: center; height: 1.375em; fill: var(--kumo-warning); }
    .banner-icon svg { width: 1em; height: 1em; }
    .banner-text { padding-top: 1px; font-size: 13px; line-height: 1.375; }

    /* Kumo Radio.Group appearance="card" orientation="horizontal" */
    .radio-group { display: flex; flex-direction: column; gap: 1rem; margin-bottom: 1.5rem; }
    .radio-legend { font-weight: 500; }
    .radio-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem; }
    .radio-card {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.75rem;
      border: 1px solid var(--kumo-hairline);
      border-radius: 8px;
      background: var(--kumo-base);
      cursor: pointer;
    }
    .radio-card:hover, .radio-card:has(.radio-input:checked) { background: var(--kumo-tint); }
    .radio-card:has(.radio-input:checked) { border-color: var(--kumo-interact); }
    .radio-card-text { display: flex; flex: 1; flex-direction: column; gap: 0.125rem; min-width: 0; }
    .radio-card-label { font-weight: 500; }
    .radio-card-description { color: var(--kumo-text-subtle); font-size: 13px; }
    .radio-input {
      appearance: none;
      display: grid;
      place-content: center;
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      margin-top: 2px;
      border-radius: 50%;
      background: var(--kumo-base);
      box-shadow: 0 0 0 2px var(--kumo-line);
      cursor: pointer;
    }
    .radio-card:hover .radio-input { box-shadow: 0 0 0 2px var(--kumo-hairline); }
    .radio-input:checked { background: var(--kumo-contrast); }
    .radio-input:checked::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--kumo-base); }
    .radio-input:focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
    .radio-description { color: var(--kumo-text-subtle); font-size: 13px; line-height: 1.375; }

    /* Actions */
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 0.5rem;
      padding-top: 1rem;
      border-top: 1px solid var(--kumo-line);
    }
    .actions .button-primary { min-width: 200px; }

    @media (max-width: 600px) {
      .main { padding: 1rem; }
      .card-body { padding: 1.25rem; }
      .radio-cards { grid-template-columns: 1fr; }
      .actions .button { flex: 1 1 100%; }
      .actions .button-primary { order: -1; }
    }
  </style>
</head>
<body>
  ${PAGE_HEADER_HTML}

  <main class="main">
    <div class="card">
      <div class="card-header">
        <h1 class="card-title">Authorize application</h1>
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
              ? `<div class="banner-alert" role="alert">
            <span class="banner-icon" aria-hidden="true"><svg viewBox="0 0 256 256"><path d="M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z"/></svg></span>
            <p class="banner-text">Local redirect: this client will receive the authorization code on this device. Only continue if you trust the application that opened this page.</p>
          </div>`
              : ''
          }
        </div>

        <div class="radio-group" role="radiogroup" aria-labelledby="templateLegend" aria-describedby="templateHelp">
          <div class="radio-legend" id="templateLegend">Access template</div>
          <div class="radio-cards" id="templates"></div>
          <p class="radio-description" id="templateHelp">Choose Full access if the application needs to make changes. You can narrow permissions further on the Cloudflare authorization screen.</p>
        </div>

        <form method="post" action="${new URL(request.url).pathname}" id="authForm">
          <input type="hidden" name="state" value="${encodedState}">
          <input type="hidden" name="csrf_token" value="${csrfToken}">
          <div id="hiddenScopes"></div>

          <div class="actions">
            <button type="button" class="button button-secondary" onclick="window.close()">Cancel</button>
            <button type="submit" class="button button-primary" id="continueBtn"><span class="button-label">Continue</span></button>
          </div>
        </form>
      </div>
    </div>
  </main>

  ${PAGE_FOOTER_HTML}

  <script>
    (function() {
      const TEMPLATES = ${templateDataJson};
      const TEMPLATE_LABELS = ${templateLabelsJson};
      const INITIAL_SCOPES = ${JSON.stringify(initialScopes)};
      const REQUIRED = new Set(${JSON.stringify(Array.from(requiredSet))});
      // The scopes the client asked for. They are the most the user can grant;
      // Cloudflare's authorization screen can only narrow them.
      const REQUESTED = '__requested__';

      const selected = new Set();
      let activeTemplate = null;
      // "Requested permissions" only appears when the client's requested
      // scopes match no template.
      let showRequested = false;

      const templatesEl = document.getElementById('templates');
      const hiddenScopesEl = document.getElementById('hiddenScopes');
      const continueBtn = document.getElementById('continueBtn');

      function escapeHtml(s) {
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }

      function renderTemplates() {
        const entries = Object.entries(TEMPLATE_LABELS).map(([key, label]) => ({ key, ...label }));
        if (showRequested) {
          entries.push({ key: REQUESTED, name: 'Requested permissions', description: 'The permissions this client asked for.' });
        }

        templatesEl.innerHTML = entries.map(e => \`
          <label class="radio-card">
            <span class="radio-card-text">
              <span class="radio-card-label">\${escapeHtml(e.name)}</span>
              <span class="radio-card-description">\${escapeHtml(e.description)}</span>
            </span>
            <input type="radio" class="radio-input" name="template" value="\${escapeHtml(e.key)}">
          </label>
        \`).join('');

        templatesEl.querySelectorAll('.radio-input').forEach(input => {
          input.addEventListener('change', () => applyTemplate(input.value));
        });
      }

      function applyTemplate(key) {
        const scopes = key === REQUESTED ? INITIAL_SCOPES : TEMPLATES[key];
        if (!scopes) return;
        selected.clear();
        for (const s of scopes) selected.add(s);
        for (const r of REQUIRED) selected.add(r);
        activeTemplate = key;
        updateActiveTemplateUI();
        renderHiddenInputs();
      }

      function updateActiveTemplateUI() {
        templatesEl.querySelectorAll('.radio-input').forEach(input => {
          input.checked = input.value === activeTemplate;
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
        continueBtn.disabled = selected.size === 0;
      }

      for (const scope of INITIAL_SCOPES) selected.add(scope);
      for (const scope of REQUIRED) selected.add(scope);
      activeTemplate = matchesExistingTemplate() || REQUESTED;
      showRequested = activeTemplate === REQUESTED;
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

  // Scopes from the chosen template, sent as hidden form fields
  const selectedScopes = formData.getAll('scopes').filter((s): s is string => typeof s === 'string')

  return {
    state,
    selectedScopes: selectedScopes.length > 0 ? selectedScopes : undefined
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
  ${PAGE_FONT_LINKS}
  <style>${PAGE_CHROME_CSS}
    .main { align-items: center; }
    .card { max-width: 440px; padding: 2.5rem 2rem; text-align: center; }
    .error-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 56px;
      height: 56px;
      margin: 0 auto 1.5rem;
      border-radius: 50%;
      background: var(--kumo-danger-tint);
    }
    .error-icon svg { width: 28px; height: 28px; color: var(--kumo-danger); }
    .card-title { margin-bottom: 0.5rem; font-size: 20px; font-weight: 600; line-height: 1.4; }
    .card-message { margin-bottom: 1.5rem; color: var(--kumo-text-subtle); }
    .error-details {
      margin-bottom: 1.5rem;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      background: var(--kumo-elevated);
      box-shadow: 0 0 0 1px var(--kumo-hairline);
      color: var(--kumo-text-subtle);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      text-align: left;
      word-break: break-word;
    }
  </style>
</head>
<body>
  ${PAGE_HEADER_HTML}
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
      <a href="javascript:window.close()" class="button button-primary" onclick="window.close(); return false;"><span class="button-label">Close window</span></a>
    </div>
  </main>
  ${PAGE_FOOTER_HTML}
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

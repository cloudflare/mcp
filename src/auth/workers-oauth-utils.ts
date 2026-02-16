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
      unauthorized_client: 'Unauthorized Client',
      access_denied: 'Access Denied',
      unsupported_response_type: 'Unsupported Response Type',
      invalid_scope: 'Invalid Scope',
      server_error: 'Server Error',
      temporarily_unavailable: 'Temporarily Unavailable'
    }
    const title = titles[this.code] || 'Authorization Error'
    return renderErrorPage(title, this.description, `Error code: ${this.code}`)
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
 * Renders an approval dialog for OAuth authorization with scope selection
 */
export function renderApprovalDialog(request: Request, options: ApprovalDialogOptions): Response {
  const { client, state, csrfToken, setCookie, scopeTemplates, allScopes, defaultTemplate, maxScopes } =
    options
  const encodedState = btoa(JSON.stringify(state))
  const clientName = client?.clientName ? sanitizeHtml(client.clientName) : 'Unknown MCP Client'

  // Build scope template options HTML
  let templateOptionsHtml = ''
  if (scopeTemplates) {
    templateOptionsHtml = Object.entries(scopeTemplates)
      .map(
        ([key, template]) => `
        <label class="template-option ${key === defaultTemplate ? 'selected' : ''}">
          <input type="radio" name="scope_template" value="${sanitizeHtml(key)}" ${key === defaultTemplate ? 'checked' : ''}>
          <div class="template-content">
            <span class="template-name">${sanitizeHtml(template.name)}</span>
            <span class="template-desc">${sanitizeHtml(template.description)}</span>
          </div>
        </label>
      `
      )
      .join('')
  }

  // Build scope groups for detailed view (grouped by category)
  let scopeGroupsHtml = ''
  if (allScopes) {
    const scopesByCategory: Record<string, Array<{ scope: string; desc: string }>> = {}
    for (const [scope, desc] of Object.entries(allScopes)) {
      const parts = scope.split(':')
      const category = parts[0].replace(/_/g, ' ')
      if (!scopesByCategory[category]) {
        scopesByCategory[category] = []
      }
      scopesByCategory[category].push({ scope, desc })
    }

    scopeGroupsHtml = Object.entries(scopesByCategory)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([category, scopes]) => `
        <div class="scope-group">
          <div class="scope-group-header">${sanitizeHtml(category)}</div>
          ${scopes
            .map(
              ({ scope, desc }) => `
            <label class="scope-item">
              <input type="checkbox" name="scopes" value="${sanitizeHtml(scope)}" class="scope-checkbox">
              <span class="scope-name">${sanitizeHtml(scope)}</span>
              <span class="scope-desc">${sanitizeHtml(desc)}</span>
            </label>
          `
            )
            .join('')}
        </div>
      `
      )
      .join('')
  }

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
      --cf-orange: #f6821f;
      --cf-orange-hover: #e5750f;
      --cf-orange-light: rgba(246, 130, 31, 0.08);
      --cf-brown: #3c2415;
      --cf-brown-light: #6b4c3a;
      --cf-cream: #fbf8f3;
      --cf-cream-dark: #f5f0e8;
      --cf-border: rgba(60, 36, 21, 0.1);
      --cf-border-dark: rgba(60, 36, 21, 0.15);
      --cf-text: #3c2415;
      --cf-text-muted: #6b5c52;
      --cf-text-light: #9a8a7c;
      --border-radius: 8px;
      --border-radius-lg: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      line-height: 1.5;
      color: var(--cf-text);
      background: var(--cf-cream);
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
      border-bottom: 1px solid var(--cf-border);
      background: white;
    }
    .cf-logo {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      text-decoration: none;
      color: inherit;
    }
    .cf-logo svg { height: 32px; width: auto; }
    .cf-logo-text {
      font-weight: 600;
      font-size: 1.1rem;
      color: var(--cf-text);
    }
    .cf-logo-divider {
      width: 1px;
      height: 24px;
      background: var(--cf-border-dark);
      margin: 0 0.5rem;
    }
    .cf-logo-product {
      font-size: 0.9rem;
      color: var(--cf-text-muted);
    }

    /* Main Content */
    .main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      background: white;
      border: 1px solid var(--cf-border);
      border-radius: var(--border-radius-lg);
      width: 100%;
      max-width: 480px;
      overflow: hidden;
      box-shadow: 0 4px 24px rgba(60, 36, 21, 0.06);
    }
    .card-header {
      padding: 1.5rem 2rem;
      border-bottom: 1px solid var(--cf-border);
      text-align: center;
    }
    .card-title {
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--cf-text);
      margin-bottom: 0.5rem;
    }
    .card-subtitle {
      font-size: 0.875rem;
      color: var(--cf-text-muted);
    }
    .card-body { padding: 1.5rem 2rem; }

    /* Client Info */
    .client-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--cf-cream);
      padding: 0.5rem 1rem;
      border-radius: 100px;
      font-size: 0.875rem;
      font-weight: 500;
      margin-bottom: 1.25rem;
      border: 1px solid var(--cf-border);
    }
    .client-badge-icon {
      width: 20px;
      height: 20px;
      background: var(--cf-orange);
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .client-badge-icon svg { width: 12px; height: 12px; }

    /* Scope Selection */
    .scope-section { margin-bottom: 1.5rem; }
    .scope-label {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--cf-text-muted);
      margin-bottom: 0.75rem;
    }
    .template-options { display: flex; flex-direction: column; gap: 0.5rem; }
    .template-option {
      display: flex;
      align-items: flex-start;
      padding: 1rem;
      border: 1px solid var(--cf-border);
      border-radius: var(--border-radius);
      cursor: pointer;
      transition: all 0.15s ease;
      background: transparent;
    }
    .template-option:hover { border-color: var(--cf-border-dark); background: var(--cf-cream); }
    .template-option.selected {
      border-color: var(--cf-orange);
      background: var(--cf-orange-light);
    }
    .template-option input[type="radio"] {
      appearance: none;
      width: 18px;
      height: 18px;
      border: 2px solid var(--cf-border-dark);
      border-radius: 50%;
      margin-right: 0.75rem;
      margin-top: 2px;
      flex-shrink: 0;
      position: relative;
      cursor: pointer;
      background: white;
    }
    .template-option input[type="radio"]:checked {
      border-color: var(--cf-orange);
      background: var(--cf-orange);
    }
    .template-option input[type="radio"]:checked::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 6px;
      height: 6px;
      background: white;
      border-radius: 50%;
    }
    .template-content { flex: 1; }
    .template-name {
      font-weight: 500;
      color: var(--cf-text);
      font-size: 0.9rem;
    }
    .template-desc {
      font-size: 0.8rem;
      color: var(--cf-text-muted);
      margin-top: 0.25rem;
      line-height: 1.4;
    }

    /* Advanced Toggle */
    .advanced-toggle {
      background: none;
      border: none;
      color: var(--cf-orange);
      cursor: pointer;
      font-size: 0.8rem;
      font-weight: 500;
      padding: 0;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      margin-bottom: 1rem;
    }
    .advanced-toggle:hover { text-decoration: underline; }
    .advanced-toggle svg {
      width: 12px;
      height: 12px;
      transition: transform 0.2s ease;
    }
    .advanced-toggle.open svg { transform: rotate(90deg); }
    .advanced-section {
      display: none;
      margin-bottom: 1.5rem;
      animation: fadeIn 0.2s ease;
    }
    .advanced-section.open { display: block; }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .scope-groups {
      max-height: 240px;
      overflow-y: auto;
      border: 1px solid var(--cf-border);
      border-radius: var(--border-radius);
      background: var(--cf-cream);
    }
    .scope-groups::-webkit-scrollbar { width: 6px; }
    .scope-groups::-webkit-scrollbar-track { background: transparent; }
    .scope-groups::-webkit-scrollbar-thumb {
      background: var(--cf-border-dark);
      border-radius: 3px;
    }
    .scope-group { padding: 0.5rem; }
    .scope-group + .scope-group { border-top: 1px solid var(--cf-border); }
    .scope-group-header {
      font-size: 0.7rem;
      font-weight: 600;
      color: var(--cf-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0.5rem;
      position: sticky;
      top: 0;
      background: var(--cf-cream);
    }
    .scope-item {
      display: flex;
      align-items: center;
      padding: 0.4rem 0.5rem;
      cursor: pointer;
      border-radius: 4px;
      font-size: 0.8rem;
    }
    .scope-item:hover { background: white; }
    .scope-item input[type="checkbox"] {
      appearance: none;
      width: 14px;
      height: 14px;
      border: 1px solid var(--cf-border-dark);
      border-radius: 3px;
      margin-right: 0.5rem;
      cursor: pointer;
      position: relative;
      flex-shrink: 0;
      background: white;
    }
    .scope-item input[type="checkbox"]:checked {
      background: var(--cf-orange);
      border-color: var(--cf-orange);
    }
    .scope-item input[type="checkbox"]:checked::after {
      content: '';
      position: absolute;
      top: 1px;
      left: 4px;
      width: 4px;
      height: 8px;
      border: solid white;
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }
    .scope-name {
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 0.75rem;
      color: var(--cf-text);
      min-width: 140px;
    }
    .scope-desc {
      color: var(--cf-text-light);
      font-size: 0.75rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Info Text */
    .info-text {
      font-size: 0.8rem;
      color: var(--cf-text-muted);
      margin-bottom: 1.5rem;
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
    }
    .info-text svg {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      margin-top: 1px;
      color: var(--cf-text-light);
    }

    /* Actions */
    .actions {
      display: flex;
      gap: 0.75rem;
      padding-top: 1rem;
      border-top: 1px solid var(--cf-border);
    }
    .button {
      flex: 1;
      padding: 0.75rem 1.25rem;
      border-radius: 100px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      font-size: 0.9rem;
      font-family: inherit;
      transition: all 0.15s ease;
      text-align: center;
    }
    .button-primary {
      background: var(--cf-orange);
      color: white;
    }
    .button-primary:hover { background: var(--cf-orange-hover); transform: translateY(-1px); }
    .button-secondary {
      background: transparent;
      border: 1px solid var(--cf-orange);
      color: var(--cf-orange);
    }
    .button-secondary:hover {
      background: var(--cf-orange-light);
    }

    /* Footer */
    .footer {
      padding: 1rem 2rem;
      text-align: center;
      font-size: 0.75rem;
      color: var(--cf-text-light);
      border-top: 1px solid var(--cf-border);
      background: white;
    }
    .footer a { color: var(--cf-text-muted); text-decoration: none; }
    .footer a:hover { color: var(--cf-orange); }
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

          ${
            scopeTemplates
              ? `
          <div class="scope-section">
            <div class="scope-label">Access Level</div>
            <div class="template-options">
              ${templateOptionsHtml}
            </div>
          </div>
          `
              : ''
          }

          ${
            allScopes
              ? `
          <button type="button" class="advanced-toggle" id="advancedToggle" onclick="toggleAdvanced()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <path d="M9 18l6-6-6-6"/>
            </svg>
            Advanced: Select individual permissions
          </button>
          <div class="advanced-section" id="advancedSection">
            ${maxScopes ? `<div id="scopeCounter" style="font-size: 0.75rem; color: var(--cf-text-muted); margin-bottom: 0.5rem; font-weight: 500;"></div>` : ''}
            <div class="scope-groups">
              ${scopeGroupsHtml}
            </div>
          </div>
          `
              : ''
          }

          <div class="info-text">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 16v-4M12 8h.01"/>
            </svg>
            <span>You'll be redirected to Cloudflare to sign in and confirm access.</span>
          </div>

          <div class="actions">
            <button type="button" class="button button-secondary" onclick="window.close()">Cancel</button>
            <button type="submit" class="button button-primary">Continue</button>
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
    const templates = ${scopeTemplates ? JSON.stringify(Object.fromEntries(Object.entries(scopeTemplates).map(([k, v]) => [k, v.scopes]))) : '{}'};
    const maxScopes = ${maxScopes || 0};

    function getCheckedCount() {
      return document.querySelectorAll('.scope-checkbox:checked').length;
    }

    function updateScopeCounter() {
      const counter = document.getElementById('scopeCounter');
      if (!counter || !maxScopes) return;
      const count = getCheckedCount();
      counter.textContent = count + ' / ' + maxScopes + ' scopes selected';
      counter.style.color = count >= maxScopes ? 'var(--cf-red, #d63031)' : 'var(--cf-text-muted)';
    }

    function enforceScopeLimit() {
      if (!maxScopes) return;
      const checked = getCheckedCount();
      document.querySelectorAll('.scope-checkbox').forEach(cb => {
        if (!cb.checked) {
          cb.disabled = checked >= maxScopes;
          cb.closest('.scope-item').style.opacity = checked >= maxScopes ? '0.5' : '1';
        }
      });
      updateScopeCounter();
    }

    document.querySelectorAll('.scope-checkbox').forEach(cb => {
      cb.addEventListener('change', enforceScopeLimit);
    });

    document.querySelectorAll('input[name="scope_template"]').forEach(radio => {
      radio.addEventListener('change', function() {
        document.querySelectorAll('.template-option').forEach(opt => opt.classList.remove('selected'));
        this.closest('.template-option').classList.add('selected');
        const selectedScopes = templates[this.value] || [];
        document.querySelectorAll('.scope-checkbox').forEach(cb => {
          cb.checked = selectedScopes.includes(cb.value);
        });
        enforceScopeLimit();
      });
    });

    const defaultTemplate = '${defaultTemplate || ''}';
    if (defaultTemplate && templates[defaultTemplate]) {
      document.querySelectorAll('.scope-checkbox').forEach(cb => {
        cb.checked = templates[defaultTemplate].includes(cb.value);
      });
      enforceScopeLimit();
    }

    function toggleAdvanced() {
      const section = document.getElementById('advancedSection');
      const toggle = document.getElementById('advancedToggle');
      section.classList.toggle('open');
      toggle.classList.toggle('open');
    }
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
    throw new Error('Invalid request method')
  }

  const formData = await request.formData()

  // Validate CSRF token
  const tokenFromForm = formData.get('csrf_token')
  if (!tokenFromForm || typeof tokenFromForm !== 'string') {
    throw new Error('Missing CSRF token')
  }

  const cookieHeader = request.headers.get('Cookie') || ''
  const cookies = cookieHeader.split(';').map((c) => c.trim())
  const csrfCookie = cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`))
  const tokenFromCookie = csrfCookie ? csrfCookie.substring(CSRF_COOKIE.length + 1) : null

  if (!tokenFromCookie || tokenFromForm !== tokenFromCookie) {
    throw new Error('CSRF token mismatch')
  }

  const encodedState = formData.get('state')
  if (!encodedState || typeof encodedState !== 'string') {
    throw new Error('Missing state')
  }

  const state = JSON.parse(atob(encodedState))
  if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
    throw new Error('Invalid state data')
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
export function renderErrorPage(title: string, message: string, details?: string): Response {
  const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${sanitizeHtml(title)} | Cloudflare</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --cf-orange: #f6821f;
      --cf-brown: #3c2415;
      --cf-cream: #fbf8f3;
      --cf-border: rgba(60, 36, 21, 0.1);
      --cf-text: #3c2415;
      --cf-text-muted: #6b5c52;
      --cf-text-light: #9a8a7c;
      --cf-red: #d63031;
      --cf-red-light: rgba(214, 48, 49, 0.08);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      line-height: 1.5;
      color: var(--cf-text);
      background: var(--cf-cream);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      padding: 1rem 2rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      border-bottom: 1px solid var(--cf-border);
      background: white;
    }
    .cf-logo { display: flex; align-items: center; gap: 0.5rem; text-decoration: none; }
    .cf-logo-divider { width: 1px; height: 24px; background: rgba(60, 36, 21, 0.15); margin: 0 0.5rem; }
    .cf-logo-product { font-size: 0.9rem; color: var(--cf-text-muted); }
    .main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }
    .card {
      background: white;
      border: 1px solid var(--cf-border);
      border-radius: 12px;
      width: 100%;
      max-width: 440px;
      overflow: hidden;
      box-shadow: 0 4px 24px rgba(60, 36, 21, 0.06);
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
      color: var(--cf-text);
      margin-bottom: 0.75rem;
    }
    .card-message {
      font-size: 0.95rem;
      color: var(--cf-text-muted);
      margin-bottom: 1.5rem;
    }
    .error-details {
      background: var(--cf-cream);
      border: 1px solid var(--cf-border);
      border-radius: 8px;
      padding: 1rem;
      font-family: 'SF Mono', Monaco, 'Courier New', monospace;
      font-size: 0.8rem;
      color: var(--cf-text-muted);
      text-align: left;
      word-break: break-word;
      margin-bottom: 1.5rem;
    }
    .button {
      display: inline-block;
      padding: 0.75rem 2rem;
      border-radius: 100px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      font-size: 0.9rem;
      font-family: inherit;
      text-decoration: none;
      background: var(--cf-orange);
      color: white;
      transition: all 0.15s ease;
    }
    .button:hover { background: #e5750f; transform: translateY(-1px); }
    .footer {
      padding: 1rem 2rem;
      text-align: center;
      font-size: 0.75rem;
      color: var(--cf-text-light);
      border-top: 1px solid var(--cf-border);
      background: white;
    }
    .footer a { color: var(--cf-text-muted); text-decoration: none; }
    .footer a:hover { color: var(--cf-orange); }
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
      <a href="javascript:window.close()" class="button" onclick="window.close(); return false;">Close Window</a>
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
    status: 400,
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

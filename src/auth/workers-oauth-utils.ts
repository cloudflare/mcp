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
        error_description: this.description,
      }),
      {
        status: this.statusCode,
        headers: { 'Content-Type': 'application/json' },
      }
    )
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
  return crypto.subtle.importKey('raw', enc.encode(secret), { hash: 'SHA-256', name: 'HMAC' }, false, [
    'sign',
    'verify',
  ])
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
async function verifySignature(key: CryptoKey, signatureHex: string, data: string): Promise<boolean> {
  const enc = new TextEncoder()
  try {
    const signatureBytes = new Uint8Array(signatureHex.match(/.{1,2}/g)!.map((byte) => Number.parseInt(byte, 16)))
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
    if (!Array.isArray(approvedClients) || !approvedClients.every((item) => typeof item === 'string')) {
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
  const { client, server, state, csrfToken, setCookie, scopeTemplates, allScopes, defaultTemplate } = options
  const encodedState = btoa(JSON.stringify(state))

  const serverName = sanitizeHtml(server.name)
  const clientName = client?.clientName ? sanitizeHtml(client.clientName) : 'Unknown MCP Client'
  const serverDescription = server.description ? sanitizeHtml(server.description) : ''
  const logoUrl = server.logo ? sanitizeHtml(server.logo) : ''

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
  <title>${clientName} | Authorization Request</title>
  <style>
    :root {
      --primary-color: #f6821f;
      --primary-hover: #e5750f;
      --border-color: rgba(255,255,255,0.1);
      --text-color: #e0e0e0;
      --text-muted: #888;
      --background-color: #1a1a2e;
      --card-bg: rgba(255,255,255,0.05);
    }
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      line-height: 1.6;
      color: var(--text-color);
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      margin: 0;
      padding: 0;
      min-height: 100vh;
    }
    .container { max-width: 600px; margin: 2rem auto; padding: 1rem; }
    .precard { padding: 2rem; text-align: center; }
    .card {
      background: var(--card-bg);
      border-radius: 16px;
      padding: 2rem;
      backdrop-filter: blur(10px);
      border: 1px solid var(--border-color);
    }
    .header { display: flex; align-items: center; justify-content: center; margin-bottom: 1rem; }
    .logo { width: 48px; height: 48px; margin-right: 1rem; border-radius: 8px; }
    .title { margin: 0; font-size: 1.5rem; font-weight: 600; color: #fff; }
    .alert { font-size: 1.1rem; margin: 1rem 0 0.5rem; text-align: center; color: #fff; }
    .client-info {
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 1rem;
      margin: 1rem 0;
      background: rgba(0,0,0,0.2);
    }
    .client-name { font-weight: 600; font-size: 1.1rem; color: #fff; }
    .description { color: var(--text-muted); margin-top: 0.5rem; font-size: 0.9rem; }

    /* Scope Selection */
    .scope-section { margin: 1.5rem 0; }
    .scope-section-title {
      font-size: 0.9rem;
      color: #fff;
      margin-bottom: 0.75rem;
      font-weight: 600;
    }

    /* Template Selection */
    .template-options { display: flex; flex-direction: column; gap: 0.5rem; }
    .template-option {
      display: flex;
      align-items: flex-start;
      padding: 0.75rem;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
      background: rgba(0,0,0,0.1);
    }
    .template-option:hover { border-color: var(--primary-color); }
    .template-option.selected { border-color: var(--primary-color); background: rgba(246, 130, 31, 0.1); }
    .template-option input { margin-right: 0.75rem; margin-top: 0.25rem; accent-color: var(--primary-color); }
    .template-content { display: flex; flex-direction: column; }
    .template-name { font-weight: 500; color: #fff; }
    .template-desc { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem; }

    /* Advanced Scope Selection */
    .advanced-toggle {
      background: none;
      border: none;
      color: var(--primary-color);
      cursor: pointer;
      font-size: 0.85rem;
      padding: 0.5rem 0;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .advanced-toggle:hover { text-decoration: underline; }
    .advanced-section { display: none; margin-top: 1rem; }
    .advanced-section.open { display: block; }
    .scope-groups {
      max-height: 300px;
      overflow-y: auto;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 0.5rem;
      background: rgba(0,0,0,0.2);
    }
    .scope-group { margin-bottom: 1rem; }
    .scope-group:last-child { margin-bottom: 0; }
    .scope-group-header {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--primary-color);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 0.5rem;
      position: sticky;
      top: 0;
      background: rgba(26, 26, 46, 0.95);
    }
    .scope-item {
      display: flex;
      align-items: flex-start;
      padding: 0.4rem 0.5rem;
      cursor: pointer;
      border-radius: 4px;
      font-size: 0.85rem;
    }
    .scope-item:hover { background: rgba(255,255,255,0.05); }
    .scope-item input { margin-right: 0.5rem; margin-top: 0.15rem; accent-color: var(--primary-color); }
    .scope-name { font-family: monospace; color: #fff; min-width: 180px; }
    .scope-desc { color: var(--text-muted); font-size: 0.8rem; }

    .actions { display: flex; justify-content: flex-end; gap: 1rem; margin-top: 1.5rem; }
    .button {
      padding: 0.75rem 1.5rem;
      border-radius: 8px;
      font-weight: 500;
      cursor: pointer;
      border: none;
      font-size: 1rem;
      transition: all 0.2s;
    }
    .button-primary { background-color: var(--primary-color); color: white; }
    .button-primary:hover { background-color: var(--primary-hover); }
    .button-secondary {
      background: transparent;
      border: 1px solid rgba(255,255,255,0.2);
      color: var(--text-color);
    }
    .button-secondary:hover { border-color: rgba(255,255,255,0.4); }
  </style>
</head>
<body>
  <div class="container">
    <div class="precard">
      <div class="header">
        ${logoUrl ? `<img src="${logoUrl}" alt="${serverName} Logo" class="logo">` : ''}
        <h1 class="title">${serverName}</h1>
      </div>
      ${serverDescription ? `<p class="description">${serverDescription}</p>` : ''}
    </div>
    <div class="card">
      <h2 class="alert"><strong>${clientName}</strong> is requesting access</h2>
      <div class="client-info">
        <div class="client-name">${clientName}</div>
        <p class="description">This MCP client wants to access the Cloudflare API on your behalf.</p>
      </div>

      <form method="post" action="${new URL(request.url).pathname}" id="authForm">
        <input type="hidden" name="state" value="${encodedState}">
        <input type="hidden" name="csrf_token" value="${csrfToken}">

        ${
          scopeTemplates
            ? `
        <div class="scope-section">
          <div class="scope-section-title">Choose access level</div>
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
        <button type="button" class="advanced-toggle" onclick="toggleAdvanced()">
          <span id="advancedArrow">▶</span> Customize permissions
        </button>
        <div class="advanced-section" id="advancedSection">
          <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.75rem;">
            Select individual scopes to customize access. This overrides the template selection above.
          </p>
          <div class="scope-groups">
            ${scopeGroupsHtml}
          </div>
        </div>
        `
            : ''
        }

        <p style="font-size: 0.85rem; color: var(--text-muted); margin-top: 1rem;">
          After approval, you will be redirected to Cloudflare to complete authentication.
        </p>

        <div class="actions">
          <button type="button" class="button button-secondary" onclick="window.history.back()">Cancel</button>
          <button type="submit" class="button button-primary">Authorize</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    const templates = ${scopeTemplates ? JSON.stringify(Object.fromEntries(Object.entries(scopeTemplates).map(([k, v]) => [k, v.scopes]))) : '{}'};

    // Handle template selection
    document.querySelectorAll('input[name="scope_template"]').forEach(radio => {
      radio.addEventListener('change', function() {
        document.querySelectorAll('.template-option').forEach(opt => opt.classList.remove('selected'));
        this.closest('.template-option').classList.add('selected');

        // Update checkboxes to match template
        const selectedScopes = templates[this.value] || [];
        document.querySelectorAll('.scope-checkbox').forEach(cb => {
          cb.checked = selectedScopes.includes(cb.value);
        });
      });
    });

    // Initialize checkboxes based on default template
    const defaultTemplate = '${defaultTemplate || ''}';
    if (defaultTemplate && templates[defaultTemplate]) {
      document.querySelectorAll('.scope-checkbox').forEach(cb => {
        cb.checked = templates[defaultTemplate].includes(cb.value);
      });
    }

    // Handle individual scope changes
    document.querySelectorAll('.scope-checkbox').forEach(cb => {
      cb.addEventListener('change', function() {
        // When user manually changes scopes, we keep the form submission working
        // The backend will read either template or individual scopes
      });
    });

    function toggleAdvanced() {
      const section = document.getElementById('advancedSection');
      const arrow = document.getElementById('advancedArrow');
      section.classList.toggle('open');
      arrow.textContent = section.classList.contains('open') ? '▼' : '▶';
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
      'X-Frame-Options': 'DENY',
    },
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
  const updatedApprovedClients = Array.from(new Set([...existingApprovedClients, state.oauthReqInfo.clientId]))

  const payload = JSON.stringify(updatedApprovedClients)
  const key = await importKey(cookieSecret)
  const signature = await signData(key, payload)
  const newCookieValue = `${signature}.${btoa(payload)}`

  return {
    state,
    headers: {
      'Set-Cookie': `${APPROVED_CLIENTS_COOKIE}=${newCookieValue}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=${ONE_YEAR_IN_SECONDS}`,
    },
    selectedScopes: selectedScopes.length > 0 ? selectedScopes : undefined,
    selectedTemplate: typeof selectedTemplate === 'string' ? selectedTemplate : undefined,
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
  await kv.put(
    `oauth:state:${stateToken}`,
    JSON.stringify({ oauthReqInfo, codeVerifier }),
    { expirationTtl: 600 }
  )
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
    setCookie: `${STATE_COOKIE}=${hashHex}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`,
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
      redirectUri: z.string().optional(),
    })
    .passthrough(),
  codeVerifier: z.string().min(1),
})

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
    clearCookie: `${STATE_COOKIE}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`,
  }
}

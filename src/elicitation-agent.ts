import { Agent } from 'agents'
import { generatePKCECodes } from './auth/cloudflare-auth'
import { ALL_SCOPES, SCOPE_TEMPLATES, REQUIRED_SCOPES, MAX_SCOPES } from './auth/scopes'
import { createOAuthState, bindStateToSession } from './auth/workers-oauth-utils'
import type { AuthRequest } from '@cloudflare/workers-oauth-provider'

export type ElicitationState = {
  errorMessage: string
  currentScopes: string[]
  tokenHash: string
  userId: string
  status: 'pending' | 'upgrading' | 'complete' | 'failed'
  createdAt: number
  completedAt?: number
  newScopes?: string[]
  failureReason?: string
} | null

const HTML_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY'
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

export class ElicitationAgent extends Agent<Env, ElicitationState> {
  initialState: ElicitationState = null

  async onStart() {
    if (this.state && this.state.status === 'pending') {
      this.schedule(Date.now() + 60 * 60 * 1000, 'cleanup')
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // Routes may arrive as /init (internal) or /elicitation/:id (browser).
    // Normalize by extracting the last path segment.
    const segments = url.pathname.replace(/\/+$/, '').split('/')
    const route = segments[segments.length - 1] || ''

    // POST /init — internal call from elicitUpdatedScopes
    if (request.method === 'POST' && route === 'init') {
      if (this.state !== null) {
        return new Response('Conflict: elicitation already initialized', { status: 409 })
      }
      const body = (await request.json()) as {
        errorMessage: string
        currentScopes: string[]
        tokenHash: string
        userId: string
      }
      this.setState({
        errorMessage: body.errorMessage,
        currentScopes: body.currentScopes,
        tokenHash: body.tokenHash,
        userId: body.userId,
        status: 'pending',
        createdAt: Date.now()
      })
      this.schedule(Date.now() + 60 * 60 * 1000, 'cleanup')
      return new Response('OK', { status: 200 })
    }

    // GET — render scope picker page (matches /elicitation/:id or /)
    if (request.method === 'GET' && (route === this.name || route === '' || !['init', 'upgrade', 'complete', 'fail'].includes(route))) {
      if (!this.state) return new Response('Not found', { status: 404 })

      if (this.state.status === 'complete') {
        return new Response(renderCompletePage(this.state.newScopes || []), { headers: HTML_HEADERS })
      }
      if (this.state.status === 'failed') {
        return new Response(renderFailedPage(this.state.failureReason || 'Unknown error'), { headers: HTML_HEADERS })
      }

      return new Response(renderScopePickerPage(this.state, this.name), { headers: HTML_HEADERS })
    }

    // POST /upgrade — user submitted new scopes, redirect to Cloudflare OAuth
    if (request.method === 'POST' && route === 'upgrade') {
      if (!this.state || this.state.status !== 'pending') {
        return new Response('Bad request', { status: 400 })
      }

      const formData = await request.formData()
      const selectedScopes = formData.getAll('scopes').filter((s): s is string => typeof s === 'string')

      if (selectedScopes.length === 0) {
        return new Response('No scopes selected', { status: 400 })
      }

      // Ensure required scopes are included
      const finalScopes = Array.from(new Set([...REQUIRED_SCOPES, ...selectedScopes])).slice(0, MAX_SCOPES)

      this.setState({ ...this.state, status: 'upgrading', newScopes: finalScopes })

      // Generate PKCE codes
      const { codeChallenge, codeVerifier } = await generatePKCECodes()

      // Build a synthetic oauthReqInfo for the state. We mark it as a scope_upgrade
      // so /oauth/callback knows to handle it differently.
      const oauthReqInfo = {
        responseType: 'scope_upgrade',
        clientId: 'scope_upgrade',
        redirectUri: '',
        scope: finalScopes,
        state: '',
        // Custom fields (preserved by .passthrough() in schema)
        elicitationId: this.name,
        tokenHash: this.state.tokenHash,
        userId: this.state.userId
      } as AuthRequest & { elicitationId: string; tokenHash: string; userId: string }

      // Store state in OAUTH_KV
      const stateToken = await createOAuthState(oauthReqInfo, this.env.OAUTH_KV, codeVerifier)

      // Bind state to session cookie
      const { setCookie: sessionCookie } = await bindStateToSession(stateToken)

      // Build Cloudflare OAuth URL
      const stateWithToken = { ...oauthReqInfo, state: stateToken }
      const baseUrl = new URL(request.url).origin
      const redirectUri = `${baseUrl}/oauth/callback`

      const urlParams = new URLSearchParams({
        response_type: 'code',
        client_id: this.env.CLOUDFLARE_CLIENT_ID,
        redirect_uri: redirectUri,
        state: btoa(JSON.stringify(stateWithToken)),
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        scope: finalScopes.join(' ')
      })

      const authUrl = `https://dash.cloudflare.com/oauth2/auth?${urlParams.toString()}`

      return new Response(null, {
        status: 302,
        headers: {
          Location: authUrl,
          'Set-Cookie': sessionCookie
        }
      })
    }

    // POST /complete — called by /oauth/callback after successful scope upgrade
    if (request.method === 'POST' && route === 'complete') {
      if (!this.state) {
        return new Response('Not found', { status: 404 })
      }
      const body = (await request.json()) as { accessToken: string; refreshToken: string; scopes: string[] }

      // Store upgraded token in KV, keyed by the old token hash
      await this.env.OAUTH_KV.put(
        `token-upgrade:${this.state.tokenHash}`,
        JSON.stringify({
          accessToken: body.accessToken,
          refreshToken: body.refreshToken,
          scopes: body.scopes,
          timestamp: Date.now()
        }),
        { expirationTtl: 3600 }
      )

      this.setState({
        ...this.state,
        status: 'complete',
        completedAt: Date.now(),
        newScopes: body.scopes
      })

      return new Response('OK', { status: 200 })
    }

    // POST /fail — called by /oauth/callback on error
    if (request.method === 'POST' && route === 'fail') {
      if (!this.state) {
        return new Response('Not found', { status: 404 })
      }
      const body = (await request.json()) as { reason: string }
      this.setState({ ...this.state, status: 'failed', failureReason: body.reason })
      return new Response('OK', { status: 200 })
    }

    return new Response('Method Not Allowed', { status: 405 })
  }

  async cleanup() {
    this.setState(null)
  }
}

// ── HTML Rendering ──────────────────────────────────────────────────────────

function renderScopePickerPage(state: NonNullable<ElicitationState>, agentId: string): string {
  const currentScopes = new Set(state.currentScopes)

  // Build scope groups (same categorization as the /authorize page)
  const scopesByCategory: Record<string, Array<{ scope: string; desc: string; checked: boolean }>> = {}
  for (const [scope, desc] of Object.entries(ALL_SCOPES)) {
    const parts = scope.split(':')
    const category = parts[0].replace(/_/g, ' ')
    if (!scopesByCategory[category]) {
      scopesByCategory[category] = []
    }
    scopesByCategory[category].push({
      scope,
      desc,
      checked: currentScopes.has(scope)
    })
  }

  const scopeGroupsHtml = Object.entries(scopesByCategory)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([category, scopes]) => `
      <div class="scope-group">
        <div class="scope-group-header">${escapeHtml(category)}</div>
        ${scopes
          .map(
            ({ scope, desc, checked }) => `
          <label class="scope-item">
            <input type="checkbox" name="scopes" value="${escapeHtml(scope)}" class="scope-checkbox" ${checked ? 'checked' : ''}>
            <span class="scope-name">${escapeHtml(scope)}</span>
            <span class="scope-desc">${escapeHtml(desc)}</span>
          </label>
        `
          )
          .join('')}
      </div>
    `
    )
    .join('')

  // Build template options
  const templateOptionsHtml = Object.entries(SCOPE_TEMPLATES)
    .map(
      ([key, template]) => `
      <label class="template-option">
        <input type="radio" name="scope_template" value="${escapeHtml(key)}">
        <div class="template-content">
          <span class="template-name">${escapeHtml(template.name)}</span>
          <span class="template-desc">${escapeHtml(template.description)}</span>
        </div>
      </label>
    `
    )
    .join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Upgrade Permissions | Cloudflare MCP</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --cf-orange: #f6821f;
      --cf-orange-hover: #e5750f;
      --cf-orange-light: rgba(246, 130, 31, 0.08);
      --cf-brown: #3c2415;
      --cf-cream: #fbf8f3;
      --cf-cream-dark: #f5f0e8;
      --cf-border: rgba(60, 36, 21, 0.1);
      --cf-border-dark: rgba(60, 36, 21, 0.15);
      --cf-text: #3c2415;
      --cf-text-muted: #6b5c52;
      --cf-text-light: #9a8a7c;
      --cf-red: #d63031;
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
    .header {
      padding: 1rem 2rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      border-bottom: 1px solid var(--cf-border);
      background: white;
    }
    .cf-logo { display: flex; align-items: center; gap: 0.5rem; text-decoration: none; }
    .cf-logo-divider { width: 1px; height: 24px; background: var(--cf-border-dark); margin: 0 0.5rem; }
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
      border-radius: var(--border-radius-lg);
      width: 100%;
      max-width: 520px;
      overflow: hidden;
      box-shadow: 0 4px 24px rgba(60, 36, 21, 0.06);
    }
    .card-header {
      padding: 1.5rem 2rem;
      border-bottom: 1px solid var(--cf-border);
      text-align: center;
    }
    .card-title { font-size: 1.25rem; font-weight: 600; color: var(--cf-text); margin-bottom: 0.5rem; }
    .card-subtitle { font-size: 0.875rem; color: var(--cf-text-muted); }
    .card-body { padding: 1.5rem 2rem; }
    .warning {
      background: #fff3cd;
      color: #856404;
      padding: 12px 16px;
      margin-bottom: 1.25rem;
      border-left: 4px solid #ffc107;
      border-radius: 4px;
      font-size: 0.85rem;
      word-break: break-word;
    }
    .scope-section { margin-bottom: 1.25rem; }
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
      padding: 0.75rem 1rem;
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
      width: 18px; height: 18px;
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
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 6px; height: 6px;
      background: white;
      border-radius: 50%;
    }
    .template-content { flex: 1; }
    .template-name { font-weight: 500; color: var(--cf-text); font-size: 0.9rem; }
    .template-desc { font-size: 0.8rem; color: var(--cf-text-muted); margin-top: 0.25rem; line-height: 1.4; }
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
    .advanced-toggle svg { width: 12px; height: 12px; transition: transform 0.2s ease; }
    .advanced-toggle.open svg { transform: rotate(90deg); }
    .advanced-section {
      display: none;
      margin-bottom: 1.25rem;
      animation: fadeIn 0.2s ease;
    }
    .advanced-section.open { display: block; }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .scope-groups {
      max-height: 300px;
      overflow-y: auto;
      border: 1px solid var(--cf-border);
      border-radius: var(--border-radius);
      background: var(--cf-cream);
    }
    .scope-groups::-webkit-scrollbar { width: 6px; }
    .scope-groups::-webkit-scrollbar-track { background: transparent; }
    .scope-groups::-webkit-scrollbar-thumb { background: var(--cf-border-dark); border-radius: 3px; }
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
      width: 14px; height: 14px;
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
      top: 1px; left: 4px;
      width: 4px; height: 8px;
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
    .info-text {
      font-size: 0.8rem;
      color: var(--cf-text-muted);
      margin-bottom: 1.25rem;
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
    }
    .info-text svg { width: 16px; height: 16px; flex-shrink: 0; margin-top: 1px; color: var(--cf-text-light); }
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
    .button-primary { background: var(--cf-orange); color: white; }
    .button-primary:hover { background: var(--cf-orange-hover); transform: translateY(-1px); }
    .button-secondary {
      background: transparent;
      border: 1px solid var(--cf-orange);
      color: var(--cf-orange);
    }
    .button-secondary:hover { background: var(--cf-orange-light); }
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
        <h1 class="card-title">Upgrade Permissions</h1>
        <p class="card-subtitle">Add scopes to your current session</p>
      </div>

      <div class="card-body">
        <div class="warning">${escapeHtml(state.errorMessage)}</div>

        <form method="post" action="/elicitation/${escapeHtml(agentId)}/upgrade" id="upgradeForm">
          <div class="scope-section">
            <div class="scope-label">Quick Select</div>
            <div class="template-options">
              ${templateOptionsHtml}
            </div>
          </div>

          <button type="button" class="advanced-toggle" id="advancedToggle" onclick="toggleAdvanced()">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <path d="M9 18l6-6-6-6"/>
            </svg>
            Select individual permissions
          </button>
          <div class="advanced-section" id="advancedSection">
            <div id="scopeCounter" style="font-size: 0.75rem; color: var(--cf-text-muted); margin-bottom: 0.5rem; font-weight: 500;"></div>
            <div class="scope-groups">
              ${scopeGroupsHtml}
            </div>
          </div>

          <div class="info-text">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 16v-4M12 8h.01"/>
            </svg>
            <span>Your current scopes are pre-selected. Add the permissions you need, then click Continue to authorize via Cloudflare.</span>
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
    <a href="https://cloudflare.com/privacypolicy">Privacy</a> &middot;
    <a href="https://cloudflare.com/terms">Terms</a> &middot;
    <a href="https://developers.cloudflare.com">Docs</a>
  </footer>

  <script>
    const templates = ${JSON.stringify(Object.fromEntries(Object.entries(SCOPE_TEMPLATES).map(([k, v]) => [k, v.scopes])))};
    const maxScopes = ${MAX_SCOPES};

    function getCheckedCount() {
      return document.querySelectorAll('.scope-checkbox:checked').length;
    }

    function updateScopeCounter() {
      const counter = document.getElementById('scopeCounter');
      if (!counter || !maxScopes) return;
      const count = getCheckedCount();
      counter.textContent = count + ' / ' + maxScopes + ' scopes selected';
      counter.style.color = count >= maxScopes ? 'var(--cf-red)' : 'var(--cf-text-muted)';
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
        // Merge: keep currently checked, add template scopes
        const currentlyChecked = new Set(
          Array.from(document.querySelectorAll('.scope-checkbox:checked')).map(cb => cb.value)
        );
        selectedScopes.forEach(s => currentlyChecked.add(s));
        document.querySelectorAll('.scope-checkbox').forEach(cb => {
          cb.checked = currentlyChecked.has(cb.value);
        });
        enforceScopeLimit();
      });
    });

    // Initialize counter
    enforceScopeLimit();

    function toggleAdvanced() {
      const section = document.getElementById('advancedSection');
      const toggle = document.getElementById('advancedToggle');
      section.classList.toggle('open');
      toggle.classList.toggle('open');
    }

    // Start with advanced open since user needs to see their current scopes
    toggleAdvanced();
  </script>
</body>
</html>`
}

function renderCompletePage(newScopes: string[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Permissions Upgraded | Cloudflare MCP</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --cf-orange: #f6821f;
      --cf-cream: #fbf8f3;
      --cf-border: rgba(60, 36, 21, 0.1);
      --cf-text: #3c2415;
      --cf-text-muted: #6b5c52;
      --cf-text-light: #9a8a7c;
      --cf-green: #00b894;
      --cf-green-light: rgba(0, 184, 148, 0.08);
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
    .main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 2rem; }
    .card {
      background: white;
      border: 1px solid var(--cf-border);
      border-radius: 12px;
      width: 100%;
      max-width: 440px;
      box-shadow: 0 4px 24px rgba(60, 36, 21, 0.06);
      text-align: center;
      padding: 2.5rem 2rem;
    }
    .success-icon {
      width: 56px; height: 56px;
      background: var(--cf-green-light);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
    }
    .success-icon svg { width: 28px; height: 28px; color: var(--cf-green); }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.75rem; }
    p { font-size: 0.95rem; color: var(--cf-text-muted); margin-bottom: 1.5rem; }
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
      <div class="success-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
      <h1>Permissions Upgraded</h1>
      <p>Your token has been upgraded with ${newScopes.length} scopes. You can close this window and retry the operation.</p>
      <a href="javascript:window.close()" class="button" onclick="window.close(); return false;">Close Window</a>
    </div>
  </main>
  <footer class="footer">
    <a href="https://cloudflare.com/privacypolicy">Privacy</a> &middot;
    <a href="https://cloudflare.com/terms">Terms</a> &middot;
    <a href="https://developers.cloudflare.com">Docs</a>
  </footer>
</body>
</html>`
}

function renderFailedPage(reason: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Upgrade Failed | Cloudflare MCP</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --cf-orange: #f6821f;
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
    .main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 2rem; }
    .card {
      background: white;
      border: 1px solid var(--cf-border);
      border-radius: 12px;
      width: 100%;
      max-width: 440px;
      box-shadow: 0 4px 24px rgba(60, 36, 21, 0.06);
      text-align: center;
      padding: 2.5rem 2rem;
    }
    .error-icon {
      width: 56px; height: 56px;
      background: var(--cf-red-light);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
    }
    .error-icon svg { width: 28px; height: 28px; color: var(--cf-red); }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.75rem; }
    p { font-size: 0.95rem; color: var(--cf-text-muted); margin-bottom: 1.5rem; }
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
      <h1>Upgrade Failed</h1>
      <p>The permission upgrade could not be completed.</p>
      <div class="error-details">${escapeHtml(reason)}</div>
      <a href="javascript:window.close()" class="button" onclick="window.close(); return false;">Close Window</a>
    </div>
  </main>
  <footer class="footer">
    <a href="https://cloudflare.com/privacypolicy">Privacy</a> &middot;
    <a href="https://cloudflare.com/terms">Terms</a> &middot;
    <a href="https://developers.cloudflare.com">Docs</a>
  </footer>
</body>
</html>`
}

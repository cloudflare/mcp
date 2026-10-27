import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import type { Hono } from 'hono'

import { cloudflareTokenOwner } from '../api-token-mode'
import { resolveCloudflareCredential } from '../cloudflare-identity'
import { OAuthError, renderStyledPage, sanitizeHtml } from '../workers-oauth-utils'
import { encryptCredential } from './credential-crypto'
import { discoverIssuer, IssuerDiscoveryError } from './issuer-discovery'
import { emaEnabled } from './provider-options'
import { deleteTenant, getTenant, putTenant, tenantUsers, type EmaTenant } from './tenant-store'

const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

interface AdminEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers
}

const PAGE_CSS = `
    .card { max-width: 720px; padding: 2rem; }
    h1 { margin: 0 0 0.5rem; font-size: 20px; font-weight: 600; }
    h2 { margin: 2rem 0 0.5rem; font-size: 16px; font-weight: 600; }
    p, li { color: var(--kumo-text-subtle); line-height: 1.5; }
    label { display: block; margin: 1rem 0 0.25rem; font-weight: 500; }
    .hint { margin: 0.25rem 0 0; font-size: 13px; }
    input, textarea {
      box-sizing: border-box;
      width: 100%;
      padding: 0.5rem 0.75rem;
      border: 0;
      border-radius: 8px;
      background: var(--kumo-base);
      color: var(--kumo-text-default);
      box-shadow: 0 0 0 1px var(--kumo-line);
      font: inherit;
    }
    textarea { min-height: 4rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    .actions { display: flex; gap: 0.5rem; margin-top: 1.5rem; flex-wrap: wrap; }
    .notice {
      margin: 1rem 0;
      padding: 0.75rem 1rem;
      border-radius: 8px;
      background: var(--kumo-warning-tint);
      color: var(--kumo-text-warning);
      font-size: 14px;
    }
    .error { background: var(--kumo-danger-tint); color: var(--kumo-danger); }
    table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; font-size: 14px; }
    th { width: 34%; padding: 0.5rem 0.75rem 0.5rem 0; color: var(--kumo-text-subtle); font-weight: 500; text-align: left; vertical-align: top; }
    td { padding: 0.5rem 0; word-break: break-all; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
    hr { margin: 2rem 0; border: 0; border-top: 1px solid var(--kumo-hairline); }`

function page(title: string, body: string, status = 200): Response {
  return renderStyledPage(title, `<div class="card">${body}</div>`, { css: PAGE_CSS, status })
}

function errorPage(message: string, status = 400): Response {
  return page(
    'Enterprise-Managed Authorization',
    `<h1>Something needs fixing</h1>
     <div class="notice error">${sanitizeHtml(message)}</div>
     <div class="actions"><a class="button button-secondary" href="/ema"><span class="button-label">Back</span></a></div>`,
    status
  )
}

function lines(value: unknown): string[] {
  return typeof value === 'string'
    ? [
        ...new Set(
          value
            .split(/[\s,]+/)
            .map((entry) => entry.trim())
            .filter(Boolean)
        )
      ]
    : []
}

function row(label: string, value: string): string {
  return `<tr><th>${sanitizeHtml(label)}</th><td><code>${sanitizeHtml(value)}</code></td></tr>`
}

/** Verify an account API token and return its account, or throw a message for the page. */
async function accountFromToken(token: string): Promise<EmaTenant['account']> {
  if (!token) throw new IssuerDiscoveryError('Paste an account API token')
  let identity
  try {
    identity = await resolveCloudflareCredential(token, cloudflareTokenOwner(token))
  } catch (error) {
    const description = error instanceof OAuthError ? error.description : 'Cloudflare rejected it'
    throw new IssuerDiscoveryError(`The token could not be verified: ${description}`)
  }
  if (identity.type !== 'account') {
    throw new IssuerDiscoveryError(
      'That is a user token. Create an account API token (Manage Account > Account API Tokens), so the MCP server acts as the account rather than as you.'
    )
  }
  return identity.account
}

function landingPage(origin: string, resource: string): Response {
  return page(
    'Enterprise-Managed Authorization',
    `<h1>Enterprise-Managed Authorization</h1>
     <p>Let people in your organization use the Cloudflare MCP server through your identity provider, with no Cloudflare sign-in and no consent screen. Your IdP decides who can connect, from which AI clients, using Cross App Access (ID-JAG).</p>
     <div class="notice">Preview. Every connection acts with the account API token you provide here, so every tool call has exactly that token's permissions. Cloudflare's audit log shows the token, not the person; this server logs the person's IdP identity with each token it issues.</div>

     <h2>Register your identity provider</h2>
     <form method="post" action="/ema/register">
       <label for="token">Account API token</label>
       <input id="token" name="account_token" type="password" autocomplete="off" required>
       <p class="hint">Create one under Manage Account &gt; Account API Tokens with the permissions agents should have. A read-only token is a good start.</p>

       <label for="issuer">Identity provider issuer URL</label>
       <input id="issuer" name="issuer" type="url" placeholder="https://your-org.okta.com" required>
       <p class="hint">The exact <code>iss</code> your IdP puts in ID-JAGs. For the Okta playground, <code>https://idp.xaa.dev</code>.</p>

       <label for="domains">Allowed email domains (optional)</label>
       <input id="domains" name="email_domains" placeholder="example.com">
       <p class="hint">When set, only ID-JAGs whose <code>email</code> is under one of these domains get a token.</p>

       <label for="clients">Other allowed client IDs (optional)</label>
       <textarea id="clients" name="client_ids" placeholder="One per line"></textarea>
       <p class="hint">This page creates a client for your organization. Add the client ID of any other AI client your IdP issues ID-JAGs to, for example Claude's.</p>

       <div class="actions"><button class="button button-primary" type="submit"><span class="button-label">Register</span></button></div>
     </form>

     <hr>
     <h2>Manage a registration</h2>
     <form method="post" action="/ema/manage">
       <label for="manage-token">Account API token for the account</label>
       <input id="manage-token" name="account_token" type="password" autocomplete="off" required>
       <div class="actions"><button class="button button-secondary" type="submit"><span class="button-label">Show registration</span></button></div>
     </form>

     <hr>
     <h2>What your IdP needs</h2>
     <table>
       ${row('Authorization server issuer (ID-JAG aud)', origin)}
       ${row('Token endpoint', `${origin}/token`)}
       ${row('MCP resource', resource)}
     </table>`
  )
}

function tenantTable(tenant: EmaTenant): string {
  return `<table>
       ${row('Account', `${tenant.account.name} (${tenant.account.id})`)}
       ${row('Status', tenant.status)}
       ${row('IdP issuer', tenant.issuer)}
       ${row('IdP JWKS', tenant.jwksUri)}
       ${row('Algorithms', tenant.algorithms.join(', '))}
       ${row('Allowed clients', tenant.clientIds.join('\n'))}
       ${row('Allowed email domains', tenant.emailDomains.join(', ') || 'any')}
     </table>`
}

function idpInstructions(origin: string, resource: string, tenant: EmaTenant): string {
  return `<h2>Configure your identity provider</h2>
     <table>
       ${row('Authorization server issuer (ID-JAG aud)', origin)}
       ${row('Token endpoint', `${origin}/token`)}
       ${row('MCP resource', resource)}
       ${row('Audience / tenant ID (aud_tenant)', tenant.account.id)}
     </table>
     <p>In Okta, open the resource app's Cross App Access settings and set the Issuer URL to the authorization server issuer above and the Audience/tenant ID to your account ID. The <code>aud_tenant</code> claim is what ties an ID-JAG for a shared client, such as Claude's, to this account.</p>
     <h2>Try it in the Okta playground</h2>
     <ol>
       <li>Open <a href="https://xaa.dev/developer/test-resource">xaa.dev, Test Your Resource App</a> and register a custom resource.</li>
       <li>Server URL: <code>${sanitizeHtml(resource)}</code>. Choose <strong>Own auth server</strong> with issuer <code>${sanitizeHtml(origin)}</code>.</li>
       <li>Target client ID: <code>${sanitizeHtml(tenant.tenantClientId)}</code>, with the client secret shown when you registered.</li>
       <li>Sign in with any email, run the four steps, and call a tool such as <code>search</code>.</li>
     </ol>`
}

/** Revoke every grant minted for the tenant. Returns how many were revoked. */
async function revokeTenantGrants(env: AdminEnv, tenant: EmaTenant): Promise<number> {
  let revoked = 0
  for (const userId of await tenantUsers(env.OAUTH_KV, tenant.account.id)) {
    let cursor: string | undefined
    do {
      const page = await env.OAUTH_PROVIDER.listUserGrants(userId, { cursor })
      for (const grant of page.items) {
        await env.OAUTH_PROVIDER.revokeGrant(grant.id, userId)
        revoked++
      }
      cursor = page.cursor
    } while (cursor)
  }
  return revoked
}

function manageForm(token: string, action: string, label: string, primary = false): string {
  return `<form method="post" action="/ema/manage">
       <input type="hidden" name="account_token" value="${sanitizeHtml(token)}">
       <input type="hidden" name="action" value="${sanitizeHtml(action)}">
       <button class="button ${primary ? 'button-primary' : 'button-secondary'}" type="submit"><span class="button-label">${sanitizeHtml(label)}</span></button>
     </form>`
}

/**
 * Admin pages at `/ema`, where an account admin registers their IdP for Enterprise-Managed
 * Authorization. Whoever holds an account API token for the account manages its registration:
 * holding the token already grants everything a registration can hand out. No cookie or session
 * is involved, so the forms carry no CSRF risk.
 */
export function registerEmaAdminRoutes(app: Hono): void {
  app.use('/ema', async (c, next) => {
    if (!emaEnabled(c.env as AdminEnv)) return c.notFound()
    await next()
  })
  app.use('/ema/*', async (c, next) => {
    if (!emaEnabled(c.env as AdminEnv)) return c.notFound()
    await next()
  })

  app.get('/ema', (c) => {
    const env = c.env as AdminEnv
    return landingPage(new URL(c.req.url).origin, env.MCP_RESOURCE)
  })

  app.post('/ema/register', async (c) => {
    const env = c.env as AdminEnv
    const origin = new URL(c.req.url).origin
    const form = await c.req.formData()
    const token = String(form.get('account_token') ?? '').trim()
    try {
      const account = await accountFromToken(token)
      const discovered = await discoverIssuer(String(form.get('issuer') ?? ''))
      const previous = await getTenant(env.OAUTH_KV, account.id)
      // A new registration gets a new client and secret; the old client stops working.
      if (previous) await env.OAUTH_PROVIDER.deleteClient(previous.tenantClientId)
      const client = await env.OAUTH_PROVIDER.createClient({
        clientName: `Enterprise-Managed Authorization: ${account.name}`,
        redirectUris: [`${origin}/ema`],
        grantTypes: [JWT_BEARER_GRANT],
        responseTypes: [],
        tokenEndpointAuthMethod: 'client_secret_post'
      })
      const now = Math.floor(Date.now() / 1000)
      const tenant: EmaTenant = {
        account,
        status: 'active',
        issuer: discovered.issuer,
        jwksUri: discovered.jwksUri,
        algorithms: discovered.algorithms,
        tenantClientId: client.clientId,
        clientIds: [client.clientId, ...lines(form.get('client_ids'))],
        emailDomains: lines(form.get('email_domains')),
        credential: await encryptCredential(env.MCP_COOKIE_ENCRYPTION_KEY, account.id, token),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      }
      await putTenant(env.OAUTH_KV, tenant, previous?.issuer)
      if (previous) await revokeTenantGrants(env, previous)

      return page(
        'Registered',
        `<h1>${sanitizeHtml(account.name)} is registered</h1>
         <p>ID-JAGs from <code>${sanitizeHtml(tenant.issuer)}</code> for the clients below now get MCP tokens that act with your account token. Changes take up to a minute to reach every location.</p>
         <h2>Your organization's client</h2>
         <div class="notice">Copy the secret now. It is not shown again; registering again replaces the client.</div>
         <table>
           ${row('Client ID', client.clientId)}
           ${row('Client secret', client.clientSecret ?? '')}
           ${row('Client authentication', 'client_secret_post')}
         </table>
         ${tenantTable(tenant)}
         ${idpInstructions(origin, env.MCP_RESOURCE, tenant)}`
      )
    } catch (error) {
      if (error instanceof IssuerDiscoveryError) return errorPage(error.message)
      throw error
    }
  })

  app.post('/ema/manage', async (c) => {
    const env = c.env as AdminEnv
    const origin = new URL(c.req.url).origin
    const form = await c.req.formData()
    const token = String(form.get('account_token') ?? '').trim()
    const action = String(form.get('action') ?? 'show')
    let account: EmaTenant['account']
    try {
      account = await accountFromToken(token)
    } catch (error) {
      if (error instanceof IssuerDiscoveryError) return errorPage(error.message)
      throw error
    }
    const tenant = await getTenant(env.OAUTH_KV, account.id)
    if (!tenant) {
      return errorPage(`${account.name} has no Enterprise-Managed Authorization registration.`, 404)
    }

    let message = ''
    if (action === 'disable' || action === 'enable') {
      const updated: EmaTenant = {
        ...tenant,
        status: action === 'disable' ? 'disabled' : 'active',
        updatedAt: Math.floor(Date.now() / 1000)
      }
      await putTenant(env.OAUTH_KV, updated)
      const revoked = action === 'disable' ? await revokeTenantGrants(env, tenant) : 0
      message =
        action === 'disable'
          ? `Disabled. ${revoked} active ${revoked === 1 ? 'grant was' : 'grants were'} revoked; new ID-JAGs are refused.`
          : 'Enabled. New ID-JAGs get tokens again.'
      Object.assign(tenant, updated)
    } else if (action === 'delete') {
      const revoked = await revokeTenantGrants(env, tenant)
      await env.OAUTH_PROVIDER.deleteClient(tenant.tenantClientId)
      await deleteTenant(env.OAUTH_KV, tenant)
      return page(
        'Deleted',
        `<h1>Registration deleted</h1>
         <p>${revoked} active ${revoked === 1 ? 'grant was' : 'grants were'} revoked and the organization's client was deleted. The account API token is no longer stored here; you can delete it in the dashboard too.</p>
         <div class="actions"><a class="button button-secondary" href="/ema"><span class="button-label">Back</span></a></div>`
      )
    }

    return page(
      'Registration',
      `<h1>${sanitizeHtml(account.name)}</h1>
       ${message ? `<div class="notice">${sanitizeHtml(message)}</div>` : ''}
       ${tenantTable(tenant)}
       <div class="actions">
         ${tenant.status === 'active' ? manageForm(token, 'disable', 'Disable and revoke tokens', true) : manageForm(token, 'enable', 'Enable', true)}
         ${manageForm(token, 'delete', 'Delete registration')}
       </div>
       ${idpInstructions(origin, env.MCP_RESOURCE, tenant)}`
    )
  })
}

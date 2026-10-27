import type {
  EmaClaimsMapperInput,
  EmaClaimsMapperResult,
  EmaOptions,
  EmaTokenIssuedEvent,
  EmaTrustedIssuer,
  EmaTrustedIssuerResolverInput
} from '@cloudflare/workers-oauth-provider'

import { SERVER_INFO } from '../../constants'
import { AuthUser, MetricsTracker } from '../../metrics'
import type { AuthProps } from '../types'
import { decryptCredential } from './credential-crypto'
import { recordTenantUser, tenantsForIssuer, type EmaTenant } from './tenant-store'

/** Whether this deployment serves Enterprise-Managed Authorization. Off unless exactly `true`. */
export function emaEnabled(env: { EMA_ENABLED?: string }): boolean {
  return env.EMA_ENABLED === 'true'
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * The MCP user ID for one IdP subject in one tenant. Hashed, so it holds no `:` and no email, and
 * scoped to the account, so the same person in two tenants gets two users.
 */
export async function emaUserId(
  accountId: string,
  issuer: string,
  subject: string
): Promise<string> {
  return `ema-${(await sha256Hex(`${accountId}\n${issuer}\n${subject}`)).slice(0, 40)}`
}

/** Why a valid ID-JAG didn't map to a tenant. Logged, never sent to the client. */
export type EmaDenial = 'no_tenant' | 'ambiguous_tenant' | 'email_domain' | 'credential'

/**
 * Pick the tenant for verified claims:
 * 1. tenants that trust the issuer and accept the client,
 * 2. narrowed to the account in `aud_tenant` when the IdP sent one,
 * 3. exactly one must remain.
 *
 * A tenant's own client (created at registration) makes the match unique without `aud_tenant`.
 * A shared client such as Claude's needs `aud_tenant`, or a single tenant trusting the issuer.
 */
export function selectTenant(
  tenants: readonly EmaTenant[],
  claims: Readonly<Record<string, unknown>>,
  clientId: string
): EmaTenant | EmaDenial {
  const forClient = tenants.filter((tenant) => tenant.clientIds.includes(clientId))
  const audTenant = typeof claims.aud_tenant === 'string' ? claims.aud_tenant : undefined
  const matching = audTenant
    ? forClient.filter((tenant) => tenant.account.id === audTenant)
    : forClient
  if (matching.length === 0) return 'no_tenant'
  if (matching.length > 1) return 'ambiguous_tenant'
  return matching[0]
}

/** Whether the tenant's email-domain rule, if any, admits `email`. */
export function emailAllowed(tenant: EmaTenant, email: unknown): boolean {
  if (tenant.emailDomains.length === 0) return true
  if (typeof email !== 'string') return false
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
  return tenant.emailDomains.some((allowed) => allowed.toLowerCase() === domain)
}

/**
 * workers-oauth-provider's `enterpriseManagedAuthorization` options for this server.
 *
 * Each tenant is a Cloudflare account whose admin registered an IdP at `/ema` and handed over an
 * account API token. A valid ID-JAG for that tenant mints an MCP token whose props carry that
 * account token, so every tool acts with the permissions the admin chose. See
 * docs/enterprise-managed-auth.md.
 */
export function createEmaOptions(env: Env): EmaOptions<Env> {
  const metrics = new MetricsTracker(env.MCP_METRICS, SERVER_INFO)
  // mapClaims and onTokenIssued see the same Request; this carries the tenant between them.
  const tenantForRequest = new WeakMap<Request, EmaTenant>()

  return {
    // The resolver sees only the unverified `iss`, so it decides issuer-level trust: every
    // tenant's JWKS URL for an issuer comes from that issuer's metadata.
    trustedIssuers: async ({
      iss,
      env
    }: EmaTrustedIssuerResolverInput<Env>): Promise<EmaTrustedIssuer | null> => {
      const [tenant] = await tenantsForIssuer(env.OAUTH_KV, iss)
      if (!tenant) return null
      return { issuer: tenant.issuer, jwksUri: tenant.jwksUri, algorithms: tenant.algorithms }
    },

    mapClaims: async ({
      claims,
      clientInfo,
      requestedScope,
      request,
      env
    }: EmaClaimsMapperInput<Env>): Promise<EmaClaimsMapperResult | null> => {
      const deny = (reason: EmaDenial) => {
        console.warn(
          JSON.stringify({
            event: 'ema_denied',
            reason,
            issuer: claims.iss,
            clientId: clientInfo.clientId,
            audTenant: claims.aud_tenant
          })
        )
        metrics.logEvent(new AuthUser({ errorMessage: `EMA denied: ${reason}` }))
        return null
      }

      const selected = selectTenant(
        await tenantsForIssuer(env.OAUTH_KV, claims.iss),
        claims,
        clientInfo.clientId
      )
      if (typeof selected === 'string') return deny(selected)
      if (!emailAllowed(selected, claims.email)) return deny('email_domain')

      let accessToken: string
      try {
        accessToken = await decryptCredential(
          env.MCP_COOKIE_ENCRYPTION_KEY,
          selected.account.id,
          selected.credential
        )
      } catch {
        return deny('credential')
      }

      tenantForRequest.set(request, selected)
      const email = typeof claims.email === 'string' ? claims.email : undefined
      return {
        userId: await emaUserId(selected.account.id, claims.iss, claims.sub),
        // The account token's permissions are the real ceiling; scopes only record what the
        // IdP allowed (see the `ema` connection in mcp-handler.ts).
        scope: requestedScope,
        metadata: {
          label: email ?? claims.sub,
          ema: { accountId: selected.account.id, issuer: claims.iss }
        },
        props: {
          type: 'account_token',
          accessToken,
          account: selected.account,
          ema: {
            issuer: claims.iss,
            subject: claims.sub,
            ...(email && { email }),
            clientId: clientInfo.clientId
          }
        } satisfies AuthProps
      }
    },

    onTokenIssued: async ({
      userId,
      grantId,
      claims,
      clientInfo,
      scope,
      expiresIn,
      request,
      env
    }: EmaTokenIssuedEvent<Env>) => {
      const tenant = tenantForRequest.get(request)
      if (!tenant) throw new Error('EMA token issued without a selected tenant')
      // Indexed so disabling the tenant revokes this grant. A failure here fails the request,
      // so no token exists that the kill switch can't reach.
      await recordTenantUser(env.OAUTH_KV, tenant.account.id, userId, expiresIn)
      console.log(
        JSON.stringify({
          event: 'ema_token_issued',
          accountId: tenant.account.id,
          issuer: claims.iss,
          subject: claims.sub,
          email: claims.email,
          clientId: clientInfo.clientId,
          userId,
          grantId,
          scope,
          expiresIn
        })
      )
      metrics.logEvent(new AuthUser({ userId }))
    }
  }
}

# Enterprise-Managed Authorization (preview)

People in an organization can use the Cloudflare MCP server through their company IdP, with no Cloudflare sign-in and no consent screen. This is the [MCP Enterprise-Managed Authorization extension](https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization), Okta's Cross App Access: the IdP issues an ID-JAG, and the client redeems it at `/token` with the jwt-bearer grant.

It's on where `EMA_ENABLED` is `"true"` (dev and staging). Production keeps it off.

## How a connection gets a Cloudflare credential

Cloudflare's OAuth server can't turn an IdP assertion into a Cloudflare token, so each organization provides one. An account admin opens `/ema`, pastes an account API token with the permissions agents should have, and enters the IdP's issuer URL. The server:

1. checks the token against `/accounts` and refuses a user token,
2. discovers the IdP's JWKS from its RFC 8414 or OpenID Connect metadata,
3. creates a client for the organization (`client_secret_post`, jwt-bearer only) and shows its secret once,
4. stores the tenant in `OAUTH_KV` under `ema-tenant:{accountId}`, with the token encrypted (AES-GCM, key derived from `MCP_COOKIE_ENCRYPTION_KEY`, account ID as additional data).

The page then lists what to enter in the IdP: the authorization server issuer (the ID-JAG's `aud`), the token endpoint, the resource, and the account ID as `aud_tenant`.

## Redeeming an ID-JAG

workers-oauth-provider checks the ID-JAG's type, signature, issuer, audience, client binding, resource, lifetime and replay marker. Then `src/auth/ema/provider-options.ts` picks the tenant: tenants that trust the issuer and accept the client, narrowed to `aud_tenant` when present, and exactly one must remain. A tenant's own client makes that unique. A shared client such as Claude's needs `aud_tenant`. An optional email-domain rule comes next.

The MCP token lasts an hour, has no refresh token, and carries `account_token` props with the admin's token and an `ema` identity. Tools run with exactly that token's permissions, so the connection is treated like a direct credential and never asks to step up.

Each issuance logs `ema_token_issued` with the account, issuer, subject, email, client and grant. Cloudflare's audit log shows only the account token, so that log line is the record of who acted. Denials log `ema_denied` with a reason, and the client always sees `invalid_grant`.

## Turning it off

`/ema/manage`, with the account token, shows the registration. Disable refuses new ID-JAGs and revokes every grant the tenant minted, found through `ema-user:{accountId}:{userId}` markers written at issuance. Delete also removes the client and the stored token. Deleting the account token in the dashboard stops every connection at the next API call.

## Trying it with Okta's playground

[xaa.dev](https://xaa.dev/developer/test-resource) can act as the IdP and the client. Register with issuer `https://idp.xaa.dev`, then register a custom resource there with this server's MCP URL, "Own auth server" with this server's origin as issuer, and the organization's client ID and secret. The playground calls `/mcp` from the browser, so staging adds `xaa.dev` to the Origin allowlist with `MCP_EXTRA_ALLOWED_ORIGINS`. Anyone can sign in to the playground's IdP with any email, so use a read-only token, or set an email domain.

## Limits of this preview

- Every person in the organization acts with one shared account token.
- The service can decrypt the stored token; grant props can only be decrypted by the token holder.
- KV is eventually consistent, so a registration or disable takes up to a minute to reach every location.
- The production design is EMA at Cloudflare's own authorization server, with per-user tokens. That needs IAM.

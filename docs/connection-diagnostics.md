# Connection diagnostics and acceptance

The authenticated `get_profile` tool follows the [OpenAI profile contract](https://developers.openai.com/plugins/build/auth#support-multiple-accounts). The same Cloudflare user has one opaque ID for OAuth and direct user credentials. Account-owned credentials use a separate profile namespace. Equal display labels do not establish equal profiles or equal connection policies. Profile metadata supports recognition; it does not update or deduplicate client-side saved connections.

The client connection store is outside this repository. Preventing extra saved rows requires the client changes and joint trace below; passing the server suite cannot prove row preservation. Do not delete saved connections or revoke real grants during investigation.

## Grant behavior verified by the server suite

With workers-oauth-provider 1.2.1, successful reauthorization creates a new grant. For the same user, client and canonical resource, its default replacement revokes the older grant after writing the pending new grant, before the client exchanges its code. A failed replacement exchange can therefore leave the old connection requiring reconnection. Replaying a consumed authorization code returns `invalid_grant` and revokes its grant, so duplicate callback handling must also avoid a second token exchange. A new DCR client ID retains a separate grant even for the same profile. The provider also separates CIMD redirects and resources when deciding replacement. Neither a grant ID nor a token generation identifies a saved client row.

Real-worker tests verify profile discovery and matching JSON/structured output in both tool modes and both protocol paths; authenticated user/account isolation; stable IDs across refreshed credentials, reconnection and scope upgrades; same-client grant replacement before exchange; code replay rejection; separate grants for new DCR clients; and failure recovery's stale-grant risk. These tests preserve the provider's existing replacement behavior.

## Remaining client implementation

1. Store explicit transaction intent: create, reconnect or upgrade. Associate reconnect/upgrade privately with the existing connection ID, expected profile and credential generation. Use fresh OAuth state and PKCE; never expose the connection ID as state.
2. Reuse that connection's client registration, callback configuration, canonical resource and endpoint/query options. Treat a changed configuration as an explicit migration. Request the necessary scope union without silently broadening permissions.
3. Keep the original row, primary selection and chat references while authorization runs. After exchange, call the designated profile tool using the new credentials. A different profile requires an explicit account-switch/add-account decision.
4. Commit credentials and granted scopes atomically to the original row using a generation/compare-and-swap guard and a transaction idempotency key. Coalesce concurrent upgrades. Duplicate or older callbacks must not insert another row, overwrite newer credentials or resurrect a removed connection.
5. On denial, cancellation, exchange failure or missing scope growth, finish without inserting. Keep useful recovery state on the existing row; if its grant was replaced, mark it as requiring reconnection. Bound permission prompts and safe retries per user action.

Preserve deliberate scope-specific or workspace-specific connections. Do not key deduplication by label, email, token, grant ID or a blanket `(client_id, user_id)` constraint. Existing-row cleanup requires a separate reviewed migration preserving primary selection and references, plus separate explicit authorization for deletion/revocation.

## Controlled joint trace

Record the host's connection gate separately from server authentication and API permissions. A not-connected error or Connect prompt can occur before any request reaches this Worker; it does not establish an OAuth or upstream API failure. Confirm the actual request path before attributing the prompt.

Use a disposable workspace and test identity. First inventory saved connection IDs, plugin/server configuration, workspace, primary selection, creation/update times and credential generations. Then capture one action through callback and storage commit:

- Client build and exact entry point; transaction intent/ID; target connection ID/generation; original API status separately from outer MCP status; requested scope set and attempt count.
- Discovery issuer and canonical resource; client ID fingerprint; callback scheme/host/path and whether DCR repeats; server deployment version and bounded timestamps/request IDs.
- Consent request and granted scopes; pending/replaced grant fingerprints and replacement outcome; callback validation and exchange result; authenticated profile ID/fingerprint.
- Client profile comparison, insert/update target, idempotency/CAS result, retry result, final row count, primary selection and retained chat references.

Use an agreed correlation ID without weakening state/PKCE. If no propagation is available, join bounded timestamps/request IDs and sanitized transaction fingerprints. Never collect raw access/refresh tokens, authorization codes, cookies, PKCE verifiers, full redirect URLs or credential hashes. Tool/auth Analytics Engine events and refused-registration diagnostics do not provide a complete transaction trace. Add only the temporary diagnostics shown necessary by a controlled trace, with agreed retention and removal; preserve the shared positional metrics schema.

## Client release gate

Verify the same saved ID, primary state and references after a read-only connection performs one write, one upgrade and one safe retry. Also verify refresh, manual reconnect and display changes; denial/cancellation/exchange failure/missing scope growth; parallel failures and duplicate callbacks; account switches; intentional add-account actions; equal labels on distinct profiles; OAuth/direct user/account credentials; changed registration/callback/resource configuration; and removal during a pending upgrade. Failures must produce useful recovery without extra rows, consent loops, silent profile replacement or delayed overwrites.

Release to a test cohort only after the joint trace passes. Track extra rows per reconnect, upgrade completion, stale credentials, repeated prompts and profile mismatches. Roll back client matching if it updates a different identity or removes an intentional connection. Production row prevention and the incident root cause remain unverified until the client owner completes this gate.

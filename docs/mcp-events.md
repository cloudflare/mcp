# MCP Events for real-time issues

The authenticated `/mcp` endpoint advertises `events: { listChanged: false }` and
implements webhook delivery from the
[MCP Events draft](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md):
`events/list`, `events/subscribe` and `events/unsubscribe`. Poll and push
(`events/poll`, `events/stream`) are not offered. The supported event is
`cloudflare.alert.workers_observability_real_time_issue`.

`events/list` describes event types and argument/payload schemas, not previous
notifications. Discovery checks ANS eligibility and Vega issue automation access.
User-account discovery is paginated with `nextCursor`.

## Subscription mapping

| MCP concept | Existing Cloudflare resource |
| --- | --- |
| Subscription | ANS notification policy |
| Callback destination | ANS generic webhook destination |
| Worker and trigger settings | Vega issue automation |
| Delivery attempts and retries | ANS webhook delivery |

The MCP Worker is stateless. Resources have a deterministic `MCP Events sub_…` name
derived from the server, principal, event, arguments and callback URL. Refresh reuses
them. Unsubscribe disables the policy first, then removes the automation, policy
and destination. Retry a failed subscribe to resume partial provisioning, or
unsubscribe to remove it. No additional database, Durable Object or queue is used.

ANS's generic webhook format differs from MCP Events, so its destination targets
`/events/ans/{subscriptionId}` on this server. This route checks the current policy
and permissions, translates the notification, signs it and awaits acceptance:

```text
Vega → ANS policy/destination → MCP callback adapter → subscriber
```

### Metadata and credentials

The policy description contains encrypted MCP metadata: owner, arguments, callback
URL, signing keys, destination ID and expiry. The destination's write-only secret
contains an encrypted delivery credential and policy/account binding. ANS sends it
to the adapter in `cf-webhook-auth`; credentials are never placed in URLs or returned
to MCP clients. Both records use AES-GCM with a purpose-specific key derived from
`MCP_COOKIE_ENCRYPTION_KEY`, bound to `MCP_RESOURCE` and the subscription.

No refresh token is retained. Provider-issued MCP tokens are revalidated through the
existing OAuth provider. Direct Cloudflare tokens are rechecked by reading the
policy and issue automations. Rotating the encryption key or changing the public
resource URL requires recreating subscriptions. Do not manually edit managed
resource names or policy descriptions.

Subscriptions default to 30 minutes and expire before the authenticating MCP token.
`ttlMs` is clamped to between one minute and one hour, never rejected; `ttlMs: null`
receives the one-hour maximum. `cursor` and `maxAgeMs` are accepted and ignored. Clients refresh
before `refreshBefore`. Key rotation dual-signs for five minutes; callback verification
is cached in the policy for five minutes for the same owner, URL and key.

Expiry stops delivery without a scheduler. Idle expired resources remain in ANS
until refresh or unsubscribe. If permissions are revoked, the policy is disabled and
an account administrator may need to remove the managed resources. `terminated` and
`gap` control envelopes are not sent (ChatGPT does not support them).

ANS creation does not expose atomic create-if-absent. Sequential retries reuse
resources; overlapping calls within an isolate are serialized. Duplicate managed
names created concurrently by different isolates produce a conflict on subsequent
requests. Remove duplicates using ANS/Vega APIs before retrying. Globally atomic
creation requires backend idempotency support.

## Arguments and permissions

Provide `account_id`, optional Worker `service`, and exactly one trigger:

- `afterOccurrences`: positive occurrence count; use `1` for new issues.
- `afterInactivitySeconds`: recurrence after 3,600–31,536,000 inactive seconds.

These are Vega settings, not ANS policy filters. Issue automations must be enabled
for the account. Credentials must allow reading and managing notification
policies/destinations and Workers Observability issue automations. Read-only OAuth
consent is insufficient for subscribing.

ChatGPT supplies its callback URL and signing secret when the user asks it to
monitor an event. The server verifies the signed callback challenge before creating
resources. Refresh and unsubscribe use the original identity and arguments.

## Errors

| Code | When |
| --- | --- |
| `-32602` InvalidParams | Arguments, callback URL or `whsec_` secret are invalid |
| `-32011` NotFound (`data.kind: "event"`) | Unknown event, or not available on the account |
| `-32012` Forbidden | Missing Cloudflare permissions, another account, or another principal's subscription |
| `-32015` CallbackEndpointError | Verification failed; `data.reason` is `challenge_failed`, `timeout`, `connection_refused`, `tls_error`, `http_4xx` or `http_5xx` |
| `-32603` | Cloudflare API failure; retry, partial resources are reused |

`events/unsubscribe` is idempotent and returns `{}` when nothing matches, as ChatGPT
expects; `delivery.mode` is optional there.

## Delivery behavior

Each ANS request makes at most one outbound attempt. A `2xx` is acknowledged. As
the draft requires, `410` and `413` are non-retryable for that delivery only: ANS
gets a `204` and the subscription stays active. Every other outcome (network
failures, timeouts, redirects, other `4xx` and `5xx`) returns `503` so ANS retries
with its own backoff. Expired, disabled, removed or unauthorized subscriptions are
acknowledged without forwarding.

The entire callback path has a four-second deadline, below ANS's five-second default.
There is no background delivery or second retry scheduler. Event IDs use Vega's
persisted run ID (`alert_correlation_id`) and the subscription ID. Redeliveries keep
the event ID/body and receive fresh signatures. Missing run IDs are rejected.

Callbacks require HTTPS on port 443, a public hostname, and no credentials or fragment.
Verification and delivery use Workers' public Internet fetch path with
`global_fetch_strictly_public`; no private-network binding is used. Workerd's default
Internet network restricts connections to public addresses. Redirects are handled
manually and never followed. Preserve those restrictions in other runtimes.
Payloads are limited to 256 KiB. Events have no replay support (`cursor: null`).
Callback acceptance acknowledges receipt, not completion of an investigation.

## Local end-to-end tests

```sh
npm ci
npm run test:events
```

The suite runs the real Worker, authentication, MCP transport, API mapping,
encryption and callback route under workerd. Only external Cloudflare APIs and the
subscriber HTTP endpoint are simulated with MSW. It covers discovery, ANS's creation
probe, provisioning, signatures, retry responses, refresh, expiry, revocation,
partial provisioning and unsubscribe. No credentials or deployment are required.

## Live test with a local Worker

This creates real resources in your selected account. Keep the original identity
and arguments for cleanup.

1. Configure the usual `.dev.vars`, including a persistent random
   `MCP_COOKIE_ENCRYPTION_KEY` of at least 32 characters. Start `npm run dev`.
2. Expose port 2529 with HTTPS:
   `cloudflared tunnel --url http://localhost:2529 --http-host-header localhost:2529`.
   Set `MCP_RESOURCE=https://<worker-tunnel>/mcp` in `.dev.vars` and restart the Worker.
   Keep that URL stable while subscribed.
3. Generate a key with
   `export MCP_EVENT_SIGNING_SECRET="whsec_$(openssl rand -base64 32)"`.
   Run `npm run events:receiver` in that environment. Expose port 8788 through another
   HTTPS tunnel; set `MCP_EVENT_CALLBACK_URL=https://<receiver-tunnel>/events`.
4. In the client terminal set `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
   `MCP_EVENT_CALLBACK_URL`, the same `MCP_EVENT_SIGNING_SECRET`, and optionally
   `MCP_EVENT_WORKER`. `MCP_URL` defaults to `http://localhost:2529/mcp`.
5. Run `node scripts/mcp-events-client.mjs list`, then
   `node scripts/mcp-events-client.mjs subscribe`. The receiver prints
   `Callback verified`; the client returns the subscription ID and expiry.
6. Trigger a new issue in the selected Worker. The receiver verifies the signature
   and prints the event. To exercise ANS retries, restart the receiver with
   `MCP_EVENT_RESPONSE_STATUS=503`, trigger an issue, then restart with its default
   status. ANS redelivers with the same event ID.
7. Run `node scripts/mcp-events-client.mjs unsubscribe` with the same account,
   Worker, callback URL and identity. Confirm removal in ANS. Unsubscribe even if
   an earlier provisioning request failed.

To use ChatGPT instead of the receiver, connect the HTTPS `/mcp` endpoint through
your plugin and ask it to monitor issues. ChatGPT supplies its own callback and key.

Protocol: https://developers.openai.com/plugins/build/mcp-events

Runtime network policy:
https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp

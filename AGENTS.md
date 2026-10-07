# AGENTS.md

## Project overview

`cloudflare-mcp` is a token-efficient Model Context Protocol (MCP) server that exposes the entire Cloudflare API (~2,500 endpoints) using Cloudflare's **Code Mode** pattern. Instead of registering thousands of MCP tools, it uses just two tools (`search` and `execute`) that let agents write JavaScript to query the OpenAPI spec and call APIs — fitting all 2,500 endpoints into ~1,000 tokens.

**Production URL:** `mcp.cloudflare.com`

## MCP specification compliance

When modifying MCP or OAuth functionality, **always check the latest published MCP specification**:

- **Specification:** https://modelcontextprotocol.io/specification/2026-07-28
- **Authorization section:** https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

## Repository structure

```
cloudflare-mcp/
├── src/
│   ├── index.ts                   # Worker entry point & OAuth routing
│   ├── mcp-handler.ts             # Stateless MCP HTTP handler & deployment guards
│   ├── server.ts                  # MCP server setup & tool registration
│   ├── executor.ts                # Code executor (Worker Loader API)
│   ├── tools-builder.ts           # ToolsBuilder Durable Object + BuildEgress: the daily build container
│   ├── forge-source.ts            # Newest Forge OpenAPI release download
│   ├── mcp-tools.ts               # mcp-tools.json contract and R2 artifact keys
│   ├── isolate-cache.ts           # One-hour in-isolate cache of the R2 artifacts
│   ├── truncate.ts                # Response truncation (~6K token limit)
│   ├── metrics.ts                 # Analytics Engine metrics (auth_user/tool_call)
│   ├── api-permissions.ts         # Connection kinds; explains refused (401/403) API calls
│   ├── api-refusal-hint.ts        # Looks up a refused execute request's permissions in spec.json
│   ├── scope-challenge.ts         # Per-request 403 insufficient_scope step-up challenge
│   ├── auth/
│   │   ├── types.ts               # Auth props schemas (Zod discriminated union)
│   │   ├── api-token-mode.ts      # Prefix classification & external resolver
│   │   ├── cloudflare-identity.ts # Owner-aware Cloudflare API identity probes
│   │   ├── cloudflare-auth.ts     # PKCE & OAuth utilities
│   │   ├── oauth-handler.ts       # OAuth authorization flow
│   │   ├── refresh-admission-gate.ts # Best-effort per-grant KV refresh admission
│   │   ├── derived-oauth-scopes.ts # Canonical production OAuth scope API metadata
│   │   ├── scopes.ts              # Consent templates and OAuth bootstrap scopes
│   │   └── workers-oauth-utils.ts # OAuth provider helpers
├── tests/                         # Vitest suite (top-level, mirrors src/)
│   ├── auth/
│   ├── executor.test.ts
│   ├── tools-builder.test.ts
│   ├── truncate.test.ts
│   └── e2e/                       # End-to-end tests (real worker via exports.default.fetch)
│       └── tool-call.test.ts
├── scripts/
│   ├── seed-r2.ts                 # Generate the artifacts locally and upload them to R2
│   └── generator/                 # Forge → spec.json, products.json, mcp-tools.json; bundled for ToolsBuilder (node:test)
├── .github/workflows/
│   ├── ci.yml                     # PR validation
│   └── bonk.yml                   # AI code review
├── wrangler.jsonc                 # Workers config (dev/staging/prod)
├── .oxfmtrc.json                  # oxfmt formatter config
└── README.md
```

## Setup

```bash
npm install    # Install dependencies
```

Node 22+ required.

## Commands

| Command                | What it does                                  |
| ---------------------- | --------------------------------------------- |
| `npm run dev`          | Start local dev server (wrangler dev)         |
| `npm run deploy`       | Deploy to staging                             |
| `npm run deploy:prod`  | Deploy to production                          |
| `npm run types`        | Generate worker type definitions              |
| `npm run typecheck`    | TypeScript type checking (no emit)            |
| `npm run lint`         | Lint with oxlint                              |
| `npm run format`       | Format with oxfmt                             |
| `npm run format:check` | Check formatting without modifying            |
| `npm run test`         | Run vitest test suite                         |
| `npm run test:watch`   | Run vitest in watch mode                      |
| `npm run check`        | Run all checks (format, lint, typecheck, test)|
| `npm run seed:local`   | Generate artifacts into local R2 (`wrangler dev`) |
| `npm run seed:staging` | Generate artifacts into staging R2            |
| `npm run seed:prod`    | Generate artifacts into production R2         |

## Code standards

### TypeScript

- Strict mode enabled
- Target: ES2022, Module: ESNext
- Runtime validation with Zod for auth props and external data

### Formatting & linting

- **oxfmt** for formatting: single quotes, no semicolons, no trailing commas
- **oxlint** for linting
- Run `npm run format` before committing

### Naming conventions

- `PascalCase` for classes, interfaces, types, enums
- `camelCase` for functions, methods, variables
- `SCREAMING_SNAKE_CASE` for constants

## Architecture

### Two-tool Code Mode pattern

The core innovation: instead of 2,500 MCP tools (~244K tokens), two tools handle everything:

1. **`search` tool** — Agents write JavaScript to query the pre-resolved OpenAPI spec (all `$ref`s inlined). Runs in an isolated worker with no network access.
2. **`execute` tool** — Agents write JavaScript using `cloudflare.request()` to call discovered endpoints. Runs in an isolated worker with outbound restricted to Cloudflare API URLs only.

`docs` (documentation search) and `whoami` are registered in both tool modes. `whoami` (`src/tools/whoami.ts`) returns the credential's identity as `user:<id>` or `account:<id>` and carries `_meta['openai/profile']` so ChatGPT can tell connected accounts apart. That ID format is a permanent contract: clients store it, so never change it. Its definition is static like every other tool's; only `tools/call` reads the credential.

### MCP HTTP serving

- `src/mcp-handler.ts` uses `createMcpHandler(factory)` directly from `@modelcontextprotocol/server`; this repository does not depend on the Agents SDK.
- Each authenticated request creates an upstream handler whose factory closes over validated `AuthProps`, matching the repository's pre-migration explicit data flow.
- The handler serves MCP `2026-07-28` and keeps the upstream default stateless 2025 compatibility path. Its factory creates a fresh `McpServer` for every request.
- No MCP session ID, protocol transport state, replay store, Durable Object, or Node async-context bridge is used. This server publishes no change notifications, so both tool modes advertise `tools.listChanged: false`. For `subscriptions/listen`, the SDK acknowledges with an empty honored filter and, since it honours none of the requested types, ends the stream straight away with a `complete` result (SDK 2.2.0+). No SSE stream stays open.
- Deployment-static Host and browser Origin allowlists cover localhost, staging, and production. Do not derive either trust list from the incoming request URL or headers.

### Worker Loader API

Code execution uses Cloudflare's Worker Loader API to dynamically create isolated worker instances. The API token is passed via props (never enters user code isolate). A `globalOutbound` service restricts network access.

### Authentication

Two credential paths produce the same Zod-validated `AuthProps` union:

- **OAuth mode** (default): `@cloudflare/workers-oauth-provider` validates its own access tokens and restores encrypted Cloudflare OAuth props. The upstream authorization-code and refresh flows use PKCE and remain separate from direct credential resolution.
- **Direct Cloudflare credential mode**: after the provider's internal lookup misses, `resolveExternalToken` validates the bearer against the Cloudflare API and returns request-local props. Prefixes are owner hints: `cfat_` account tokens query only `/accounts`; `cfut_` user API tokens and `cfoat_` Cloudflare OAuth credentials query `/user` and `/accounts`; unprefixed legacy tokens retain response-based inference. Expected failures use the provider's `ExternalTokenError`, which generates RFC 6750/9728 `401`/`403` challenges and preserves retry guidance.

Validated direct-credential identity is cached by token hash in `OAUTH_KV`; provider-issued MCP tokens never invoke the external resolver.

Downstream refreshes pass through a best-effort per-grant admission gate. An isolate-local block deterministically rejects same-isolate competitors; an owner-verified KV claim reduces cross-isolate races. A successful callback retains a short 10-second tombstone so the concurrent request burst receives structured `429 temporarily_unavailable` responses instead of independently rotating downstream refresh tokens, while preserving most of Cloudflare OAuth's 90-second upstream retry grace for provider persistence failures. Callback errors release admission. KV is eventually consistent, so this is load shedding and race reduction rather than a linearizable mutex.

The consent page offers read-only and full-access templates built from the production catalog returned by `GET /oauth/scopes` in every deployment. It has no per-scope picker. A collapsed "Advanced" section shows the selected template's scopes as editable text, one per line; editing them replaces the template (the cards grey out) so users can request a short list, e.g. when a corporate proxy rejects the long Cloudflare authorization URL that full access produces. Scopes outside the catalog block Continue because the provider only approves `scopesSupported`. Cloudflare's authorization screen can only narrow the requested scopes, so the template or edited list is the most a user can grant there. Templates saved in the browser by the old picker still appear and can be removed, but new ones can't be created. Staging may register additional scopes, but the templates include them only after they reach production. Only the user, account, and offline-access OAuth bootstrap scopes sit outside the API catalog. Terraform registration must land before deploying template additions. The app does not impose a scope-count cap.

### Spec artifacts (ToolsBuilder container)

Everything the Worker reads about the API comes from one daily build of the newest public Forge OpenAPI release (`cloudflare/forge`, `openapi@<sha>`). The Worker never derives tools or fetches specs at request time.

- The cron (`0 0 * * *`) calls the `ToolsBuilder` Durable Object (`src/tools-builder.ts`). It uses the native `ctx.container` API with the `durable_object` scheduling policy and the Cloudflare-managed `cloudflare/debian-trixie` image (Node.js 24): no Dockerfile, no image build, no `@cloudflare/containers` wrapper.
- Each run starts a fresh `standard-1` container with `enableInternet: false` and one `exec()`: `node --input-type=module -` with the bundled generator (`generated/tools-generator.mjs.txt`, built by `npm run build:generator`) on stdin. The container is destroyed afterwards.
- The container's only way out is `BuildEgress`, a `WorkerEntrypoint` the Durable Object routes two hostnames to with `interceptOutboundHttp`:
  - `GET http://forge.internal/openapi.forge.json` returns the newest Forge document (`src/forge-source.ts` follows `releases/latest/download`, no GitHub REST API) with the release in `x-forge-release`.
  - `PUT http://artifacts.internal/<key>` streams one of `spec.json`, `products.json`, `mcp-tools.json` into `SPEC_BUCKET`, with the release in custom metadata. Anything else gets 403.
- The generator builds all three artifacts before uploading any, so a failed build writes nothing and fails the cron invocation.
  - `spec.json`: every operation with `$ref`s inlined, for the `search` sandbox.
  - `products.json`: products by operation count. A product is the first `x-fern-sdk-group-name` entry, the same grouping that names the direct tools.
  - `mcp-tools.json`: the direct-tool catalogue. The tool set and names match the cf CLI's generated commands (`dns_records_create`); see `scripts/generator/README.md`. `account_id` is optional on every account-scoped tool with one fixed description, because clients cache tool metadata across users.
- `src/isolate-cache.ts` caches the artifacts for one hour in warm isolates.
- With `?codemode=false`, low-level MCP handlers serve `mcp-tools.json` as-is: `tools/list` returns each entry's `name`, `title`, `description`, `inputSchema` and `annotations`; `tools/call` looks the entry up by name, checks the schema's required keys, fills `account_id` from the session when it can, and builds one Cloudflare API request from the entry's `request` routes. The API validates argument values. No per-endpoint SDK tools are registered.
- Forge is a build-time dependency vendored as `vendor/cloudflare-forge-0.1.0.tgz`. Generator tests run with `node --test` (`npm run test:generator`), outside the workers pool. The workers pool can't run containers; `tests/tools-builder.test.ts` covers `BuildEgress`, the Forge download and the scheduled dispatch.
- `wrangler dev` runs without containers (`dev.enable_containers: false`); use `npm run seed:local` to fill local R2.

### Refused API calls

Cloudflare answers a missing OAuth scope, an endpoint OAuth can't reach (billing, API tokens), and a missing role all with `403` and `10000: Authentication error` or `9109: Unauthorized`. Agents read that as a signed-out connection and ask users to reconnect, which changes nothing. So every 401/403 tool error names the method, path, status and Cloudflare's errors, and adds an explanation from `src/api-permissions.ts`:

- The connection kind comes from the provider's `ctx.auth`. A token the provider issued carries `clientId` and its granted `scope` (`oauth`). A directly resolved credential carries neither (`direct`).
- The endpoint's accepted permissions come from Forge's `x-api-token-group`, which the build copies into each `spec.json` operation and each `mcp-tools.json` entry (`permissions`). OAuth scopes share those names (`DERIVED_OAUTH_SCOPES`). Any one permission is enough.
- The explanation says one of four things. The connection lacks every scope the endpoint accepts: grant one. It already holds one: reconnecting won't help. No OAuth scope exists for the endpoint: use an API token. For a direct credential: these are the permissions the token needs.
- `execute`: `GlobalOutbound` sets the explanation in an `X-Cloudflare-MCP-Refusal-Hint` response header. The sandbox puts it in the error it throws, so it survives code that catches the error. Endpoint tools add it to the tool result, using their own entry's permissions. `execute` matches the refused path against `spec.json`, parsed only for refused requests.

#### Step-up (`403 insufficient_scope`)

When an OAuth connection lacks every scope a refused endpoint accepts, and `scopeToRequest` can name one, the request is answered with the spec's step-up challenge instead of the tool result. The challenge comes from `insufficientScope()` in workers-oauth-provider and names the baseline (`user:read account:read`) plus that scope. The client re-authorizes and retries the same tool call. Accumulating earlier scopes is the client's job, per the spec.

- The challenge is raised only after Cloudflare refuses, never beforehand from the spec, because the permission-name mapping isn't reliable enough to block calls on.
- Retrying has to be safe. An endpoint tool makes one request. In `execute`, the refusal must be what made the code fail, and every request the code sent must have been a GET/HEAD or refused (the sandbox wraps `fetch` before the code runs). Otherwise the tool error says why the code wasn't retried.
- The sandbox reports the scope (`X-Cloudflare-MCP-Missing-Scope` from `GlobalOutbound`), so it is untrusted. The host accepts only catalog scopes the connection lacks. Code that lies can only trigger a challenge it could also get by calling the endpoint.
- A connection that already holds an accepted scope is never challenged, so a wrong pick can't loop.
- For OAuth connections, 2025-era POSTs are served as JSON (`enableJsonResponse`) rather than the SDK fallback's SSE, so the status is still open when a tool asks to step up.
- Tools also put the challenge in the error result's `_meta["mcp/www_authenticate"]`. With `?scopeChallenge=tool` that result is sent as-is, for clients such as ChatGPT that read the challenge there.

### Response truncation

Responses capped at ~6,000 tokens (~24KB). `src/truncate.ts` shrinks oversized JSON structurally so it stays valid JSON: arrays keep whole items from the start and end with a `--- TRUNCATED --- N more items` element, long strings are clipped, and objects drop their largest values first, naming them in a `--- TRUNCATED ---` entry. Plain text is cut at the cap and followed by a notice with the original size.

Clients that bound results themselves can pass `?truncateToolResult=false` to get whole results from `search`, `execute`, and the endpoint tools. `src/mcp-handler.ts` reads it next to `?codemode=false`; both are on unless the value is exactly `false`.

### Usage metrics (Analytics Engine)

Tool usage is tracked via the `MCP_METRICS` Analytics Engine binding into the shared `mcp-metrics-{dev,staging,production}` dataset — the same dataset used by the per-product Cloudflare MCP servers (`cloudflare/mcp-server-cloudflare`), so this server shows up alongside them under server name `cloudflare-api`.

- `src/metrics.ts` mirrors the upstream `@repo/mcp-observability` schema. The blob/double layout is **positional and must not change**: `index1` = event type, `blob1`/`blob2` = server name/version (reserved), `blob3` = userId, `blob4` = toolName/errorMessage, `double1` = errorCode.
- `attachMetrics()` in `src/server.ts` wraps Code-Mode `registerTool` calls; the lazy non-Code-Mode dispatcher records the same `tool_call` events directly. `auth_user` events are emitted from the OAuth handler.
- **No `session_start`**: MCP `2026-07-28` has no protocol sessions or `initialize` handshake. The 2025 compatibility path also creates a fresh server for each request and retains no initialization state. Client identity remains visible at the HTTP layer through `User-Agent` (including zone HTTP analytics).
- The tracker is tolerant of a missing binding (no-op in tests/local dev) and swallows write errors so metrics can never break a tool call.
- Query via the Analytics Engine SQL API: `SELECT ... FROM 'mcp-metrics-production' WHERE blob1='cloudflare-api' AND index1='tool_call'`.

## Security considerations

- API tokens never enter user code isolates — passed via worker props
- `globalOutbound` service restricts execute tool to Cloudflare API URLs only
- Search tool runs with no network access
- OAuth uses PKCE (RFC 7636) for secure authorization
- Cookie encryption for OAuth sessions (`MCP_COOKIE_ENCRYPTION_KEY`)
- The `/mcp` route validates Host and present browser Origin headers against deployment-static allowlists before authentication

## Testing

Tests live in the top-level `tests/` directory (mirroring `src/`) and use **vitest** with `@cloudflare/vitest-pool-workers`.

```bash
npm run test          # Single run
npm run test:watch    # Watch mode
```

**Unit/integration coverage areas:**
- Daily build egress, Forge download and scheduled dispatch
- Auth token detection and parsing
- Auth props building and validation
- Direct-tool serving and request building
- Response truncation
- Metrics event mapping & path normalization

**End-to-end (`tests/e2e/`):**
Drives the real worker via `exports.default.fetch()` (from `cloudflare:workers`), the
pattern from the [Cloudflare vitest recipes](https://developers.cloudflare.com/workers/testing/vitest-integration/recipes/).
A full JSON-RPC `tools/call` for `execute` runs real code inside a Worker Loader
isolate and is forwarded through the real `GlobalOutbound` proxy. The **only** mock
is outbound `fetch()`, declared with **MSW** (`server.use(http.get(...))`) — see
`tests/e2e/msw-server.ts` and `tests/e2e/msw-setup.ts`. MSW intercepts both the
auth-guard `/user`+`/accounts` probes and the GlobalOutbound-forwarded API call.
Everything else — auth, MCP transport, tool dispatch, Worker Loader — is the real
code path.

The test stack is **vitest 4 + `@cloudflare/vitest-pool-workers` 0.22** (its bundled wrangler is overridden to the
project's, which understands the `durable_object` container policy) using the
`cloudflareTest()` Vite plugin (required for MSW's `msw/node` to load under
workerd). Note: storage isolation is per test **file** (not per test), so tests
sharing real bindings (e.g. `OAUTH_KV`) must clear state in `afterEach`.

## Contributing

### Pull request process

CI runs on every PR:

1. `npm ci` — Clean install
2. `npm run format:check` — oxfmt formatting check
3. `npm run lint` — oxlint
4. `npm run typecheck` — TypeScript type checking
5. `npm run test` — Vitest test suite

All checks must pass before merge.

### Bonk (AI code review)

Mention `/bonk` or `@ask-bonk` in PR comments to get AI-powered code review and suggestions. Bonk can analyze code, suggest fixes, and even auto-commit improvements.

## Boundaries

**Always:**

- Run `npm run check` before considering work done
- Add tests for new functionality
- Consider security implications — this handles API tokens and OAuth flows
- Use Zod for runtime validation of external data

**Ask first:**

- Adding new dependencies
- Changing authentication flows or token handling
- Modifying the OpenAPI spec processing pipeline
- Changing deployment configuration or bindings

**Never:**

- Hardcode secrets or API keys
- Allow user code to access API tokens directly
- Bypass `globalOutbound` network restrictions
- Force push to main

## Keeping AGENTS.md updated

Update this file when:

- Adding new modules or significant features
- Changing project structure
- Modifying build/test tooling
- Adding new code patterns or conventions
- Changing contribution workflows

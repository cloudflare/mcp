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
│   ├── spec-processor.ts          # OpenAPI spec fetching & $ref resolution
│   ├── truncate.ts                # Response truncation (~6K token limit)
│   ├── metrics.ts                 # Analytics Engine metrics (auth_user/tool_call)
│   ├── skills/
│   │   ├── types.ts               # Skills extension wire + R2 manifest schemas (Zod)
│   │   ├── tar.ts                 # Minimal tar reader for the GitHub archive
│   │   ├── bundle.ts              # Skill validation, frontmatter, digests
│   │   ├── sync.ts                # Six-hourly incremental cloudflare/skills → R2 sync
│   │   └── handlers.ts            # skills/list, skills/get, resources/* handlers
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
│   ├── index.test.ts
│   ├── auth/
│   ├── executor.test.ts
│   ├── spec-processor.test.ts
│   ├── truncate.test.ts
│   └── e2e/                       # End-to-end tests (real worker via exports.default.fetch)
│       └── tool-call.test.ts
├── scripts/
│   └── seed-r2.ts                 # Seed OpenAPI spec to R2 bucket
├── docs/
│   └── connection-guides/         # Client-specific MCP setup guides
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
| `npm run seed:staging` | Seed OpenAPI spec to staging R2               |
| `npm run seed:prod`    | Seed OpenAPI spec to production R2            |

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

### OpenAPI spec processing

- Fetched from GitHub every six hours (scheduled handler, cron `0 */6 * * *`), alongside the skills sync; the two jobs run independently under `Promise.allSettled`
- All `$ref` references resolved inline before storage
- Products and minimal operation metadata extracted
- Stored in R2 bucket (`SPEC_BUCKET`) as `spec.json`, `products.json`, and `mcp-tools.json`, the direct-tool catalogue for `?codemode=false`
- `mcp-tools.json` holds the final wire JSON Schemas (including the session-independent optional `account_id`) plus minimal request-routing metadata. Each isolate builds the `tools/list` payload from it once and serves it unchanged; `tools/call` lazily validates/dispatches only the requested operation with Zod. No per-endpoint SDK tools are registered
- `src/isolate-cache.ts` caches all three artifacts for one hour in warm isolates. Concurrent requests on a cold isolate share one load, and a failed load is not cached. There is no fallback: a missing `mcp-tools.json` fails the request, so seed R2 (`npm run seed:staging` / `seed:prod`) before deploying a change to its key or shape

### Skills over MCP

The server implements the MCP Skills extension (`io.modelcontextprotocol/skills`, [SEP-2640](https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx)) in both tool modes and serves the skills from [`cloudflare/skills`](https://github.com/cloudflare/skills).

- **Sync:** on the same six-hourly cron as the spec, the scheduled handler downloads the repository tarball from codeload (one request, not subject to the GitHub API rate limit), reads it with `src/skills/tar.ts`, and turns each `skills/<name>/` directory into one skill. A skill is left out, with a logged reason, if its directory name isn't a valid skill name, it has no `SKILL.md` frontmatter with string `name` and `description`, the `name` doesn't match the directory, or it exceeds the spec's 512-file / 16 MiB limits. Frontmatter is parsed with `yaml` (core schema) and passed through verbatim as JSON.
- **Storage:** files are content-addressed at `skills/files/<sha256 hex>`, and `skills/manifest.json` holds every entry plus each file's MIME type, encoding and digest. A sync writes only bytes R2 doesn't already hold, writes the manifest after them and only when a skill entry changed, then deletes files that neither the new nor the previous manifest names. Keeping the previous manifest's files covers isolates that still cache it, which relies on the one-hour isolate TTL being shorter than the six-hour sync interval. The served bytes for a digest therefore always match it. A failed sync, or one that finds no valid skills, changes nothing. The manifest records the source commit from the tarball's pax header.
- **Serving:** `skills/list` and `skills/get` return complete manifests (`sha256` digest and size for every file). `resources/read` serves each file at `skill://<name>/<path>`; `resources/list` lists only each skill's `SKILL.md`. Results are the same for every user, so they carry `ttlMs: 1h` and `cacheScope: "public"`. `directoryRead` is not declared because every manifest is complete. Before the first sync the listing is empty, which the spec allows.
- Unknown skill URIs, unknown files and unissued cursors answer `-32602`.

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
- Skill content comes from `cloudflare/skills` only. The tar reader keeps regular files and drops symlinks, links and paths with `.`/`..` segments, and `resources/read` serves only URIs in the synced manifest
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
- Scheduled handler (spec fetching & processing, skills sync)
- Skills: tar reading, frontmatter, manifests and digests, and the skills extension end to end
- Auth token detection and parsing
- Auth props building and validation
- Spec processor ($ref resolution, product extraction)
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

The test stack is **vitest 4 + `@cloudflare/vitest-pool-workers` 0.16** using the
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

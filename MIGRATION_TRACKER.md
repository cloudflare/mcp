# MCP TypeScript SDK v2 Migration Tracker

Tracks the migration from `@modelcontextprotocol/sdk` v1 to the split v2
packages and the later move to the stateless MCP `2026-07-28` HTTP handler.
`@modelcontextprotocol/server` and the test-only client are exact-pinned to the
latest published beta, `2.0.0-beta.4` (verified 2026-07-20).

Current upgrade branch: `feat/mcp-sdk-v2-stateless`, created from `origin/main`
at `fe731a8`.

## Stateless beta.4 handler migration

| #   | Change                                | Repository impact                                                                                                                                             | Status  |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1   | Upgrade the split SDK packages        | Server and test client exact-pinned to `2.0.0-beta.4`; lockfile updated as one transaction                                                                    | Done    |
| 2   | Adopt the upstream HTTP entry         | `src/mcp-handler.ts` uses `createMcpHandler(factory)` directly from `@modelcontextprotocol/server`                                                            | Done    |
| 3   | Serve modern MCP                      | MCP `2026-07-28` requests use a fresh SDK v2 server factory                                                                                                   | Done    |
| 4   | Retain published-client compatibility | The upstream default stateless 2025 fallback remains enabled; `legacy: 'reject'` is not set                                                                   | Done    |
| 5   | Keep the protocol stateless           | No MCP session ID, transport storage, event replay state, Durable Object, SSE GET, or session DELETE path                                                     | Done    |
| 6   | Preserve application and auth state   | OAuth grants, credentials, API-token identity cache, R2 spec artifacts, Analytics Engine, and Worker Loader infrastructure remain                             | Done    |
| 7   | Preserve both auth modes              | Direct API tokens and provider-issued OAuth tokens both pass validated `AuthProps` explicitly into a request-local handler factory                           | Done    |
| 8   | Protect the HTTP boundary             | Static localhost/staging/production Host and Origin allowlists run before authentication; modern CORS preflight headers are served explicitly                 | Done    |
| 9   | Add wire regressions                  | Modern discovery/list, concurrent Code Mode surfaces, stateless 2025 fallback, GET/DELETE rejection, Host/Origin policy, preflight, and real OAuth token flow | Done    |
| 10  | Validate locally                      | `npm run check`: 17 files / 289 tests; `npm ci`, dependency tree, and production audit clean                                                                  | Done    |
| 11  | Bundle production configuration       | Production upload: 1294.29 KiB raw / 242.92 KiB gzip; 120 ms startup                                                                                           | Done   |
| 12  | Deploy and smoke-test production      | Runtime commit `ba95888`; version `bca4d618-2eab-429b-a62a-71623c98c55e`; authenticated modern and legacy smokes passed                                        | Done   |

### Serving design

- Each authenticated HTTP request creates an upstream handler whose factory
  closes over the request's validated `AuthProps`, preserving the explicit data
  flow used before this migration.
- The repository has no dependency on the Agents SDK. The only MCP runtime
  packages are the split TypeScript SDK packages.
- The existing `?codemode=false` request input is read from the factory's
  `requestInfo`, so concurrent requests can safely expose different tool
  surfaces without sharing a connected server.
- No Node ambient types, async-context bridge, or implicit global auth state is
  required.
- Handler options are intentionally omitted, preserving the upstream defaults:
  `legacy: 'stateless'` and `responseMode: 'auto'`.
- Ordinary modern responses remain JSON. The upstream stateless 2025 fallback
  returns SSE for claimless legacy requests; this is compatible with Streamable
  HTTP clients, which must accept both JSON and SSE, and no session ID is issued.
- Browser Host/Origin trust is deployment-static. It must never be derived from
  the incoming request URL, Host header, or Origin header.

### Beta.4 validation

```sh
npm ci
npm run check
npm ls --all
npm audit --omit=dev
npx wrangler deploy --dry-run --env staging
```

- `format:check`, lint, typecheck, and all **289 tests in 17 files** pass.
- Modern wire tests cover `server/discover`, `tools/list`, `resultType`, absent
  `Mcp-Session-Id`, and concurrent Code Mode/non-Code-Mode factories.
- Legacy wire tests prove claimless 2025 `tools/list` still works statelessly and
  authenticated bodyless GET/DELETE requests return `405` without factory
  construction, while unauthenticated requests remain protected with `401`.
- Deployment tests cover accepted production Host/Origin, rejected foreign and
  self-consistent attacker Host/Origin pairs, and authenticated modern CORS
  preflight headers.
- The real OAuth provider integration completes registration, authorization,
  callback, code exchange, and a modern authenticated `tools/list`; direct-token
  Worker Loader execution remains covered separately.
- `npm ci`, `npm ls --all`, and the production dependency audit are clean. The
  unmet entries shown by `npm ls` are platform/framework optional dependencies.
- Production deployed from runtime commit `ba95888` as version
  `bca4d618-2eab-429b-a62a-71623c98c55e`: **1294.29 KiB raw / 242.92 KiB
  gzip**, with a **120 ms** startup.
- Live authenticated smoke tests passed for modern discovery, list, Code Mode
  call, non-Code-Mode call, and the stateless legacy fallback. Public metadata,
  auth rejection, CORS preflight, hostile-Origin rejection, no-session headers,
  and authenticated GET `405` behavior also passed.

## Historical beta.2 upgrade tally (`2.0.0-beta.1` → `2.0.0-beta.2`)

| #   | Change                                 | Repository impact                                                         | Status |
| --- | -------------------------------------- | ------------------------------------------------------------------------- | ------ |
| 1   | Upgrade `@modelcontextprotocol/server` | Production dependency pinned to `2.0.0-beta.2`                            | Done   |
| 2   | Upgrade `@modelcontextprotocol/client` | Test-only dev dependency pinned to `2.0.0-beta.2`                         | Done   |
| 3   | Refresh npm lock data                  | Tarball URLs and integrity hashes now resolve beta.2                      | Done   |
| 4   | Review beta.2 compatibility            | No application source changes required                                    | Done   |
| 5   | Run repository validation              | Format, lint, typecheck, and all 265 tests pass                           | Done   |
| 6   | Deploy and smoke-test staging          | Deployed; metadata/auth routes pass, Wrangler-token limitation documented | Done   |

Beta.2 adds ESM/CommonJS dual-package exports to both packages. The server also
fixes the HTTP mapping for a post-dispatch `MissingRequiredClientCapabilityError`
so an uncommitted response uses the specification-required `400 Bad Request`.
This repository consumes the ESM/workerd exports and does not directly handle
that SDK error, so neither release change requires source adaptation.

## Historical package split

| Package                        | Before          | After                               |
| ------------------------------ | --------------- | ----------------------------------- |
| `@modelcontextprotocol/sdk`    | `^1.26.0` (dep) | removed                             |
| `@modelcontextprotocol/server` | —               | `2.0.0-beta.2` (dep)                |
| `@modelcontextprotocol/client` | —               | `2.0.0-beta.2` (devDep, tests only) |

v2 is a package split: the server APIs move to `@modelcontextprotocol/server`
(root export — there is no `/server/*` or `/types.js` subpath anymore) and the
`Client` used in tests moves to `@modelcontextprotocol/client`.

`@cfworker/json-schema` is **not** required as a direct dependency. In the v1
alpha it had to be installed manually; the v2 beta bundles the Workers JSON
Schema validator inline (`validators/cf-worker`) and selects it automatically on
the `workerd`/`browser` export conditions via the package's `_shims` entry, so
wrangler's bundle picks it up with no extra wiring.

## Historical v1-to-v2 code changes

### Imports (`@modelcontextprotocol/sdk/...` → `@modelcontextprotocol/server`)

- At this stage, `src/index.ts` continued using
  `WebStandardStreamableHTTPServerTransport`. The beta.4 migration above later
  replaced that raw transport wiring with the upstream `createMcpHandler`
  factory entry.
- `src/server.ts`, `src/metrics.ts` — `McpServer` (value / type).
- `src/tools/{search,execute,docs-search}.ts` — `McpServer` type; `Tool` type.

### Low-level tool handlers (`src/tools/non-codemode.ts`)

`CallToolRequestSchema` / `ListToolsRequestSchema` no longer exist. v2's
`Protocol.setRequestHandler` takes the **method string** for spec methods:

```diff
-server.server.setRequestHandler(ListToolsRequestSchema, () => ({ ... }))
-server.server.setRequestHandler(CallToolRequestSchema, async (request) => { ... })
+server.server.setRequestHandler('tools/list', () => ({ ... }))
+server.server.setRequestHandler('tools/call', async (request) => { ... })
```

The handler still receives the full parsed request (`request.params.name`,
`request.params.arguments`) and returns a `CallToolResult`, so the body is
unchanged. `Tool` and `CallToolResult` are imported as types from the root.
The `registerCapabilities({ tools: ... })` call must stay before the handlers —
v2 throws if a handler is registered for an undeclared capability.

### Standard Schema tool config

v2 `registerTool` expects a Standard Schema for `inputSchema`/`outputSchema`
rather than a raw `{ field: zodType }` shape (the raw shape is a deprecated
auto-wrapped overload). Wrapped in `z.object(...)`:

- `src/tools/search.ts` — `inputSchema`
- `src/tools/execute.ts` — both `inputSchema` shapes
- `src/tools/docs-search.ts` — `inputSchema` and `outputSchema`

### Wire-format alignment with the v2 SDK

The non-Code-Mode path serves precomputed tool definitions that must stay
byte-identical to what the Code-Mode `registerTool` path emits (enforced by
`tests/non-codemode.test.ts`). Two v2 output changes were mirrored in the
precomputed artifacts:

- **JSON Schema dialect** — v2 (zod v4) emits
  `$schema: "https://json-schema.org/draft/2020-12/schema"` instead of v1's
  `draft-07`. Updated in `src/openapi.ts` (`buildJsonInputSchema`) and the
  `DOCS_TOOL` constant in `src/tools/docs-search.ts`.
- **`execution.taskSupport`** — v1 emitted `execution: { taskSupport: 'forbidden' }`
  by default; v2 omits `execution` for non-task tools. Dropped from the
  `NonCodemodeTool` type, `buildNonCodemodeTools`, `toWireTool`, and `DOCS_TOOL`.

### Tests (`tests/non-codemode.test.ts`)

`Client` now comes from `@modelcontextprotocol/client`; `InMemoryTransport` and
`McpServer` from `@modelcontextprotocol/server`.

## Validation

### Historical beta.2 upgrade

```sh
npm run check   # format:check, lint, typecheck, test
npm run deploy  # wrangler deploy --env staging
```

- `format:check`, `lint`, `typecheck`: pass.
- `npm test`: **265 passed** (16 files), including the Worker integration suite.
  One initial parallel run encountered transient five-second cold-start timeouts;
  the affected test passed in isolation, ESM resolution was confirmed, and an
  unchanged full rerun passed all tests in 9.85 seconds.
- Staging deployed successfully with a 94 ms Worker startup:

  ```txt
  Worker:     cloudflare-api-mcp-staging
  URL:        https://staging.mcp.cloudflare.com
  Version ID: 8dc659f6-c631-4961-9717-e73bd094dbeb (100% traffic)
  ```

- Deployed-worker smoke checks:
  - `GET /.well-known/oauth-protected-resource` → `200`.
  - `GET /.well-known/oauth-authorization-server` → `200`.
  - unauthenticated `POST /mcp` → `401 invalid_token`.
  - Wrangler OAuth token → production API identity probes return `200`.
  - the same Wrangler token → staging API identity probes return `403`.
  - authenticated `tools/list` through the staging Worker therefore returns
    `403 insufficient_scope` before MCP dispatch, as expected for a production
    token presented to `api.staging.cloudflare.com`.

  The token was read directly from `wrangler auth token --json`, was never
  printed or persisted, and cannot exercise authenticated MCP dispatch while the
  staging Worker correctly targets the staging Cloudflare API. The full MCP
  protocol, tool dispatch, and Worker Loader paths are covered by the passing
  local Worker integration suite.

### Original beta.1 migration baseline

The initial v1-to-v2 migration passed 261 tests (16 files), including the e2e
suite that drives the real worker (`exports.default.fetch`) through the full
Streamable HTTP transport, tool dispatch, and a real Worker Loader isolate call.
It was deployed to staging with a 107 ms startup and no bundle/boot errors,
confirming the bundled `workerd` validator shim resolved on the edge.

Historical beta.1 staging deploy:

```txt
Worker:     cloudflare-api-mcp-staging
URL:        https://staging.mcp.cloudflare.com
Version ID: a3ff901c-61ca-4e6f-bfc1-008b66b5fef8
```

Deployed-worker smoke checks:

- `GET /.well-known/oauth-protected-resource` → `200` (correct resource metadata).
- `GET /.well-known/oauth-authorization-server` → `200`.
- `POST /mcp` without auth → `401 invalid_token` (routes to the auth guard).

A full authenticated `tools/list` / `tools/call` against the *staging* endpoint
needs a token valid on the **staging** Cloudflare API (`api.staging.cloudflare.com`);
a production API token returns `403` there (verified: prod API `200`, staging
API `403` for the same token), independent of this migration. The protocol
round-trip against `2.0.0-beta.1` is covered by the e2e test suite.

## Notes

- The original `2.0.0-beta.1` install required overriding the local npm
  `min-release-age`; beta.2 was old enough at upgrade time to install normally.
- Tests still emit the existing `vitest-pool-workers` global-scope logging noise,
  but the run passes.

# MCP TypeScript SDK v2 Migration Tracker

Tracks the migration from `@modelcontextprotocol/sdk` v1 to the split v2
packages, plus follow-up upgrades while v2 is in beta. Both packages are pinned
to the latest beta published on npm, `2.0.0-beta.2` (verified 2026-07-06).

Current upgrade branch: `chore/mcp-sdk-beta-2`, created from `origin/main` at
`3d46b04`.

## Beta upgrade tally (`2.0.0-beta.1` → `2.0.0-beta.2`)

| # | Change | Repository impact | Status |
| --- | --- | --- | --- |
| 1 | Upgrade `@modelcontextprotocol/server` | Production dependency pinned to `2.0.0-beta.2` | Done |
| 2 | Upgrade `@modelcontextprotocol/client` | Test-only dev dependency pinned to `2.0.0-beta.2` | Done |
| 3 | Refresh npm lock data | Tarball URLs and integrity hashes now resolve beta.2 | Done |
| 4 | Review beta.2 compatibility | No application source changes required | Done |
| 5 | Run repository validation | Format, lint, typecheck, and all 265 tests pass | Done |
| 6 | Deploy and smoke-test staging | Deployed; metadata/auth routes pass, Wrangler-token limitation documented | Done |

Beta.2 adds ESM/CommonJS dual-package exports to both packages. The server also
fixes the HTTP mapping for a post-dispatch `MissingRequiredClientCapabilityError`
so an uncommitted response uses the specification-required `400 Bad Request`.
This repository consumes the ESM/workerd exports and does not directly handle
that SDK error, so neither release change requires source adaptation.

## Package changes

| Package | Before | After |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | `^1.26.0` (dep) | removed |
| `@modelcontextprotocol/server` | — | `2.0.0-beta.2` (dep) |
| `@modelcontextprotocol/client` | — | `2.0.0-beta.2` (devDep, tests only) |

v2 is a package split: the server APIs move to `@modelcontextprotocol/server`
(root export — there is no `/server/*` or `/types.js` subpath anymore) and the
`Client` used in tests moves to `@modelcontextprotocol/client`.

`@cfworker/json-schema` is **not** required as a direct dependency. In the v1
alpha it had to be installed manually; the v2 beta bundles the Workers JSON
Schema validator inline (`validators/cf-worker`) and selects it automatically on
the `workerd`/`browser` export conditions via the package's `_shims` entry, so
wrangler's bundle picks it up with no extra wiring.

## Code changes

### Imports (`@modelcontextprotocol/sdk/...` → `@modelcontextprotocol/server`)

- `src/index.ts` — `WebStandardStreamableHTTPServerTransport`. This transport
  still exists in v2 (root export, same options: `sessionIdGenerator`,
  `enableJsonResponse`, `retryInterval`; same `handleRequest(request)` /
  `close()`), so this is a one-line import repoint with no behavior change.
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

### Current beta.2 upgrade

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

# MCP TypeScript SDK v2 Migration Tracker

Migrates this server from `@modelcontextprotocol/sdk` v1 to the v2 packages
`@modelcontextprotocol/server` and `@modelcontextprotocol/client`, pinned to the
`2.0.0-beta.1` release candidate.

Branch: `chore/mcp-sdk-migration` (rebuilt on top of current `main`).

## Package changes

| Package | Before | After |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | `^1.26.0` (dep) | removed |
| `@modelcontextprotocol/server` | — | `2.0.0-beta.1` (dep) |
| `@modelcontextprotocol/client` | — | `2.0.0-beta.1` (devDep, tests only) |

v2 is a package split: the server APIs move to `@modelcontextprotocol/server`
(root export — there is no `/server/*` or `/types.js` subpath anymore) and the
`Client` used in tests moves to `@modelcontextprotocol/client`.

`@cfworker/json-schema` is **not** required as a direct dependency. In the v1
alpha it had to be installed manually; `2.0.0-beta.1` bundles the Workers JSON
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

```sh
npm run check   # format:check, lint, typecheck, test
npm run deploy  # wrangler deploy --env staging
```

- `format:check`, `lint`, `typecheck`: pass.
- `npm test`: **261 passed** (16 files), including the e2e suite that drives the
  real worker (`exports.default.fetch`) through the full Streamable HTTP
  transport, tool dispatch, and a real Worker Loader isolate call — against
  `2.0.0-beta.1`.
- `npm run deploy`: deployed to staging. Worker startup 107 ms, no bundle/boot
  errors (confirms the bundled `workerd` validator shim resolves on the edge).

Staging deploy:

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

- `2.0.0-beta.1` was published within the last 3 days, so installing it requires
  overriding the local `min-release-age` npm setting for the intentional install
  (`npm install --min-release-age=0`).
- Tests still emit the existing `vitest-pool-workers` global-scope logging noise,
  but the run passes.

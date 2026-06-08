# AGENTS.md

## Project overview

`cloudflare-mcp` is a token-efficient Model Context Protocol (MCP) server that exposes the entire Cloudflare API (~2,500 endpoints) using Cloudflare's **Code Mode** pattern. Instead of registering thousands of MCP tools, it uses just two tools (`search` and `execute`) that let agents write JavaScript to query the OpenAPI spec and call APIs — fitting all 2,500 endpoints into ~1,000 tokens.

**Production URL:** `mcp.cloudflare.com`

## MCP specification compliance

When modifying MCP or OAuth functionality, **always check the latest published MCP specification**:

- **Specification:** https://modelcontextprotocol.io/specification/2025-11-25
- **Authorization section:** https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization

## Repository structure

```
cloudflare-mcp/
├── src/
│   ├── index.ts                   # Worker entry point & OAuth/Hono routing
│   ├── server.ts                  # MCP server setup & tool registration
│   ├── executor.ts                # Code executor (Worker Loader API)
│   ├── spec-processor.ts          # OpenAPI spec fetching & $ref resolution
│   ├── truncate.ts                # Response truncation (~6K token limit)
│   ├── metrics.ts                 # Analytics Engine metrics (session_start/tool_call)
│   ├── auth/
│   │   ├── types.ts               # Auth props schemas (Zod discriminated union)
│   │   ├── api-token-mode.ts      # Direct Cloudflare API token support
│   │   ├── cloudflare-auth.ts     # PKCE & OAuth utilities
│   │   ├── oauth-handler.ts       # OAuth authorization flow
│   │   ├── scopes.ts              # OAuth scope definitions (120+ scopes)
│   │   └── workers-oauth-utils.ts # OAuth provider helpers
│   └── tests/
│       ├── index.test.ts
│       ├── auth/
│       ├── executor.test.ts
│       ├── spec-processor.test.ts
│       └── truncate.test.ts
├── scripts/
│   └── seed-r2.ts                 # Seed OpenAPI spec to R2 bucket
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

### Worker Loader API

Code execution uses Cloudflare's Worker Loader API to dynamically create isolated worker instances. The API token is passed via props (never enters user code isolate). A `globalOutbound` service restricts network access.

### Authentication

Two modes via Zod discriminated union (`AuthProps`):

- **OAuth mode** (default): Uses `@cloudflare/workers-oauth-provider` with PKCE. Supports both account-scoped and user-scoped tokens.
- **API token mode**: Direct Cloudflare API tokens bypass OAuth. Detection: OAuth tokens have 3 colon-separated parts; API tokens don't.

Max 76 OAuth scopes enforced (Cloudflare server limitation).

### OpenAPI spec processing

- Fetched from GitHub daily (scheduled handler, cron `0 0 * * *`)
- All `$ref` references resolved inline before storage
- Products and minimal operation metadata extracted
- Stored in R2 bucket (`SPEC_BUCKET`)

### Response truncation

Responses capped at ~6,000 tokens (~24KB). Truncation notice included with original size to prompt agents to write more specific queries.

### Usage metrics (Analytics Engine)

Tool usage is tracked via the `MCP_METRICS` Analytics Engine binding into the shared `mcp-metrics-{dev,staging,production}` dataset — the same dataset used by the per-product Cloudflare MCP servers (`cloudflare/mcp-server-cloudflare`), so this server shows up alongside them under server name `cloudflare-api`.

- `src/metrics.ts` mirrors the upstream `@repo/mcp-observability` schema. The blob/double layout is **positional and must not change**: `index1` = event type, `blob1`/`blob2` = server name/version (reserved), `blob3` = userId, `blob4` = toolName/errorMessage, `double1` = errorCode.
- `attachMetrics()` in `src/server.ts` wraps `registerTool` so every tool (search, execute, docs, non-codemode) emits a `tool_call` event (with `errorCode` on failure). `auth_user` events are emitted from the OAuth handler.
- **No `session_start`**: unlike the Durable-Object-backed servers, this server is stateless (a fresh `McpServer` per request), so `oninitialized` fires on a different request than `initialize` and can never see client info. Client identity comes from the HTTP `User-Agent` header (visible in zone HTTP analytics) instead.
- The tracker is tolerant of a missing binding (no-op in tests/local dev) and swallows write errors so metrics can never break a tool call.
- Query via the Analytics Engine SQL API: `SELECT ... FROM 'mcp-metrics-production' WHERE blob1='cloudflare-api' AND index1='tool_call'`.

## Security considerations

- API tokens never enter user code isolates — passed via worker props
- `globalOutbound` service restricts execute tool to Cloudflare API URLs only
- Search tool runs with no network access
- OAuth uses PKCE (RFC 7636) for secure authorization
- Cookie encryption for OAuth sessions (`MCP_COOKIE_ENCRYPTION_KEY`)

## Testing

Tests use **vitest** with `@cloudflare/vitest-pool-workers`.

```bash
npm run test          # Single run
npm run test:watch    # Watch mode
```

**Test coverage areas:**
- Scheduled handler (spec fetching & processing)
- Auth token detection and parsing
- Auth props building and validation
- Spec processor ($ref resolution, product extraction)
- Response truncation

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

# MCP TypeScript SDK v2 Migration Tracker

Worktree: `/Users/matt/Documents/Github/cloudflare-mcp-mcp-sdk-migration`
Branch: `chore/mcp-sdk-migration`
SDK codemod source: `/Users/matt/Documents/Github/typescript-sdk` checked out to PR #1950 (`pr-1950`).

## What was run

1. Built the codemod from the SDK PR checkout:

   ```sh
   cd /Users/matt/Documents/Github/typescript-sdk
   pnpm install
   pnpm --filter @modelcontextprotocol/codemod build
   ```

2. Ran the codemod against this repo:

   ```sh
   cd /Users/matt/Documents/Github/cloudflare-mcp-mcp-sdk-migration
   node /Users/matt/Documents/Github/typescript-sdk/packages/codemod/dist/cli.mjs v1-to-v2 . --verbose
   ```

## Codemod changes

The codemod reported `5` changes across `2` source files and updated `package.json`:

- `src/index.ts`
  - Rewrote `WebStandardStreamableHTTPServerTransport` import from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` to `@modelcontextprotocol/server`.
- `src/server.ts`
  - Rewrote `McpServer` import from `@modelcontextprotocol/sdk/server/mcp.js` to `@modelcontextprotocol/server`.
  - Wrapped several inline `inputSchema` object literals in `z.object(...)`.
- `package.json`
  - Removed `@modelcontextprotocol/sdk`.
  - Added `@modelcontextprotocol/server`.

## Manual follow-ups required

### 1. Dynamic `inputSchema` variable was not migrated

The codemod handled inline `inputSchema: { ... }`, but missed this dynamic schema object:

```ts
const inputSchema = buildInputSchema(operation, path)
server.registerTool(toolName, { description, inputSchema }, async (params) => { ... })
```

`tsc` failed with:

```txt
src/server.ts(280,52): error TS2741: Property ''~standard'' is missing in type 'Record<string, ZodType<unknown, unknown, $ZodTypeInternals<unknown, unknown>>>' but required in type 'StandardSchemaWithJSON<unknown, unknown>'.
src/server.ts(280,74): error TS7006: Parameter 'params' implicitly has an 'any' type.
```

Manual fix applied:

```ts
server.registerTool(toolName, { description, inputSchema: z.object(inputSchema) }, async (params) => {
```

Potential codemod improvement: detect `inputSchema` shorthand/property values whose type is an object map of zod fields and wrap the property value in `z.object(...)`.

### 2. `@cfworker/json-schema` is required by the current SDK alpha and was added manually

After the codemod and `npm install`, `npm test` and `wrangler deploy --env staging` failed because the current `@modelcontextprotocol/server@2.0.0-alpha.2` package imports `@cfworker/json-schema`, but it was not installed.

Test/deploy failure examples:

```txt
No such module ".../node_modules/@modelcontextprotocol/server/dist/@cfworker/json-schema".
imported from ".../node_modules/@modelcontextprotocol/server/dist/src-IKPjmxu7.mjs"
```

```txt
Could not resolve "@cfworker/json-schema"
node_modules/@modelcontextprotocol/server/dist/src-IKPjmxu7.mjs:2:26:
  2 │ import { Validator } from "@cfworker/json-schema";
```

Manual fix applied:

```sh
npm install @cfworker/json-schema
```

Manual dependency now present in this branch:

```json
"@cfworker/json-schema": "^4.1.1"
```

Potential codemod/package improvement: if `@modelcontextprotocol/server` requires `@cfworker/json-schema` at runtime, either the server package should declare/bundle it or the codemod should add it when migrating server projects. SDK PR #2088 is exploring bundling automatic validator defaults so app projects would not need this direct dependency in a future SDK release.

### 3. Initial SDK codemod build failed before installing SDK workspace deps

Running the codemod build before `pnpm install` failed with:

```txt
ERROR Error: File '@modelcontextprotocol/tsconfig' not found.
```

Resolved by running `pnpm install` in the SDK checkout first.

## Validation

After the manual fixes above:

```sh
npm run format
npm run typecheck
npm test
npm run deploy
```

Results:

- `npm run typecheck`: passed.
- `npm test`: passed, `178` tests.
- `npm run deploy`: deployed to staging.

Staging deploy:

```txt
Worker: cloudflare-api-mcp-staging
URL: https://staging.mcp.cloudflare.com
Version ID: ae597c7a-8a4e-4514-b18a-1c7f515b9918
```

Notes:

- Tests still emit existing `vitest-pool-workers` / CIMD global-scope logging noise, but the run passed.
- `npm install` reports existing audit findings; not addressed as part of this migration.

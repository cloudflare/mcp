# Spec artifact generator

Generates everything the Worker reads about the Cloudflare API from a bundled Forge OpenAPI document (`openapi.forge.json` from a `cloudflare/forge` `openapi@<sha>` release):

- `mcp-tools.json` (`mcp.ts`): the direct-tool catalogue, `{ version: 1, tools: [...] }`. Its contract is `src/mcp-tools.ts`.
- `spec.json` and `products.json` (`spec.ts`): the `$ref`-inlined spec the `search` tool queries, and products by operation count.

```ts
import { buildArtifacts } from './artifacts.ts'

const { files } = await buildArtifacts(openapi) // { 'spec.json', 'products.json', 'mcp-tools.json' }
```

`cli.ts` is the container entrypoint: it downloads the document from `http://forge.internal/openapi.forge.json` and uploads each file to `http://artifacts.internal/<key>`, both answered by the Worker's `BuildEgress`. It is bundled by `npm run build:generator` and runs in the `ToolsBuilder` container (`src/tools-builder.ts`). `scripts/seed-r2.ts` runs `buildArtifacts` locally.

## Tool arguments

Names come from Forge's command groups and methods, such as `dns_records_create`. Parameters retain their API names and types. Header arguments use a `header_` prefix. Colliding argument names receive a location prefix; the request metadata records the mapping.

Request bodies stay nested JSON values rather than flattened CLI flags or stringified JSON:

```json
{
  "account_id": "abc",
  "body": {
    "name": "example",
    "origin": { "host": "db.example.com", "port": 5432 }
  }
}
```

Each tool has a self-contained JSON Schema 2020-12 `inputSchema`. It preserves nested required fields, enums, arrays, unions and constraints. Reachable component references are copied into local `$defs`, including recursive schemas. OpenAPI 3.0 nullable and exclusive bounds are translated to JSON Schema.

For endpoints with multiple body formats, `content_type` selects the body schema. The default is `application/json`, then a `+json` type, then the first media type in sorted order. Single-format endpoints have no `content_type` argument. Multipart fields retain their schema and encoding metadata; the generator does not upload files or encode multipart requests.

## Forge controls

- `x-fern-sdk-group-name` and `x-fern-sdk-method-name` determine names. Command-tree aliases and Forge's name disambiguation are preserved. Named operations without operation IDs are included too; operations without Forge names are not invented here.
- `x-fern-ignore: true` excludes operations, aliases, parameters and request fields. Referenced ignored fields are also excluded. Ignored/read-only fields are removed from the containing schema's required list.
- Audience filtering matches the cf CLI: absent/null audiences are included; an explicit `x-fern-audiences` list must include `cf-cli` (or `mcp`). Operations tagged only `sdk` or `terraform` are excluded, as in cf.
- The tool set matches the cf CLI's generated commands, and tool names are cf command paths joined with `_`:
  - deprecated methods are dropped
  - hidden methods are kept (cf registers them without listing them in help), except hidden operations with no 2xx/101 response
  - a group named like a sibling method is dropped, because the method wins
  - other lifecycle statuses (e.g. `beta`) are recorded in `status`
- `x-forge-params` supplies `description`, `required`, `default`, `choices`, `array` and `hidden` overrides. Nested body fields use dotted API paths. `default: null` clears the schema default. CLI presentation/file flags such as `positional` and `fromFile` do not apply.
- `x-forge-require-confirmation` appears in the description and makes the tool destructive even if its HTTP method is normally read-only. Other writes are conservatively destructive too. Hints are not authorization checks.
- `x-api-token-group` and `x-cfPermissionsRequired` are copied into `permissions` without interpreting or enforcing them.
- `account_id` is never required and always carries the same description. The server fills in the session's account when it can, and tool metadata must not depend on the caller.

## Consuming the artifact

For `tools/list`, project each entry's `name`, `title`, `description`, `inputSchema` and `annotations`. Do not send internal routing fields as protocol tool fields.

For `tools/call`, look up the entry by name, validate against its `inputSchema`, then use `request`:

- `method` and `path` identify the endpoint.
- `pathParams`, `queryParams`, `headerParams` and `cookieParams` map argument keys to wire names. Each includes the API's `style`, `explode`, `allowReserved` and optional parameter content type.
- `body.contentType` is the default body format. `body.content` lists the formats and their encoding metadata. The `body` argument is the original API-shaped value.

The server (`src/tools/non-codemode.ts`) still owns validation, HTTP serialization, authentication, account resolution, result formatting and error handling. The generator does not start an MCP server. Consumers do not need OpenAPI at request time.

Input must be a bundled Forge OpenAPI document with local JSON Pointer references. Generation fails on missing/external references rather than publishing an incomplete catalogue. This is not a general OpenAPI validator. It does not currently generate response/output schemas or interpret OpenAPI 3.1 `$id`/dynamic-reference vocabularies.

## Checks

```sh
npm run test:generator
```

Tests use Ajv as a development-only dependency to check acceptance and rejection of real input values, not only schema shape.

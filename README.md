# cloudflare-mcp

> A smol MCP server for the complete Cloudflare API.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mattzcarey/cloudflare-mcp)

Uses codemode to avoid dumping too much context to your agent.

## Get Started

### Create API Token

Create a [Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens) with the permissions you need.

Both **user tokens** and **account tokens** are supported:

| Token Type | Description | Requirements |
|------------|-------------|--------------|
| User Token | Created at user level, can access multiple accounts | Requires `account_id` parameter on each execute call |
| Account Token | Scoped to single account | `account_id` auto-detected, no parameter needed |

For account tokens, include the **Account Resources : Read** permission so the server can auto-detect your account ID.

### Add to Agent

MCP URL: `https://cloudflare-mcp.mattzcarey.workers.dev/mcp`
Bearer Token: Your [Cloudflare API Token](https://dash.cloudflare.com/profile/api-tokens)

#### Claude Code

<details>
<summary>CLI</summary>

```bash
export CLOUDFLARE_API_TOKEN="your-token-here"

claude mcp add --transport http cloudflare-api https://cloudflare-mcp.mattzcarey.workers.dev/mcp \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

</details>

#### OpenCode

<details>
<summary>opencode.json</summary>

Set your API token as an environment variable:

```bash
export CLOUDFLARE_API_TOKEN="your-token-here"
```

Then add to your `opencode.json`:

```json
{
  "mcp": {
    "cloudflare-api": {
      "type": "remote",
      "url": "https://cloudflare-mcp.mattzcarey.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer {env:CLOUDFLARE_API_TOKEN}"
      }
    }
  }
}
```

</details>

## The Problem

The Cloudflare OpenAPI spec is **2.3 million tokens** in JSON format. Even compressed to TypeScript endpoint summaries, it's still **~50k tokens**. Traditional MCP servers that expose every endpoint as a tool, or include the full spec in tool descriptions, leak this entire context to the main agent.

This server solves the problem by using **code execution** in a [codemode](https://blog.cloudflare.com/code-mode/) pattern - the spec lives on the server, and only the results of queries are returned to the agent.

## Tools

Two tools where the agent writes code to search the spec and execute API calls. Akin to [ACI.dev's MCP server](https://github.com/aipotheosis-labs/aci) but with added codemode.

| Tool      | Description                                                                   |
| --------- | ----------------------------------------------------------------------------- |
| `search`  | Write JavaScript to query `spec.paths` and find endpoints                     |
| `execute` | Write JavaScript to call `cloudflare.request()` with the discovered endpoints |

**Token usage:** Only search results and API responses are returned. The 6MB spec stays on the server.

```
Agent                         MCP Server
  │                               │
  ├──search({code: "..."})───────►│ Execute code against spec.json
  │◄──[matching endpoints]────────│
  │                               │
  ├──execute({code: "..."})──────►│ Execute code against Cloudflare API
  │◄──[API response]──────────────│
```

## Supported Products

Workers, KV, R2, D1, Pages, DNS, Firewall, Load Balancers, Stream, Images, AI Gateway, Vectorize, Access, Gateway, and more. See the full [Cloudflare API schemas](https://github.com/cloudflare/api-schemas).

## Usage

Once configured, just ask your agent to do things with Cloudflare:

- "List all my Workers"
- "Create a KV namespace called 'my-cache'"
- "Add an A record for api.example.com pointing to 192.0.2.1"

The agent will search for the right endpoints and execute the API calls. Here's what happens behind the scenes:

```javascript
// 1. Search for endpoints
search({
  code: `async () => {
    const results = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (op.tags?.some(t => t.toLowerCase() === 'workers')) {
          results.push({ method: method.toUpperCase(), path, summary: op.summary });
        }
      }
    }
    return results;
  }`,
});

// 2. Execute API call (user token - account_id required)
execute({
  code: `async () => {
    const response = await cloudflare.request({
      method: "GET",
      path: \`/accounts/\${accountId}/workers/scripts\`
    });
    return response.result;
  }`,
  account_id: "your-account-id",
});

// 2. Execute API call (account token - account_id auto-detected)
execute({
  code: `async () => {
    const response = await cloudflare.request({
      method: "GET",
      path: \`/accounts/\${accountId}/workers/scripts\`
    });
    return response.result;
  }`,
});
```

## Token Comparison

| Content                       | Tokens     |
| ----------------------------- | ---------- |
| Full OpenAPI spec (JSON)      | ~2,352,000 |
| Endpoint summary (TypeScript) | ~43,000    |
| Typical search result         | ~500       |
| API response                  | varies     |

## Architecture

```
src/
├── index.ts      # MCP server entry point
├── server.ts     # Search + Execute tools
├── executor.ts   # Isolated worker code execution
├── truncate.ts   # Response truncation (10k token limit)
└── data/
    ├── types.generated.ts  # Generated endpoint types
    ├── spec.json           # OpenAPI spec for search
    └── products.ts         # Product list
```

Code execution uses Cloudflare's Worker Loader API to run generated code in isolated workers, following the [codemode pattern](https://github.com/cloudflare/agents/tree/main/packages/codemode).

## Development

```bash
npm i
npm run deploy
```

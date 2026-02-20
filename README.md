# Cloudflare MCP Server

> A token-efficient MCP server for the entire Cloudflare API. 2500 endpoints in 1k tokens, powered by [Code Mode](https://blog.cloudflare.com/code-mode-mcp/).

## Token Comparison

| Approach                                    | Tools | Token cost | Context used (200K) |
| ------------------------------------------- | ----- | ---------- | ------------------- |
| Raw OpenAPI spec in prompt                  | —     | ~2,000,000 | 977%                |
| Native MCP (full schemas)                   | 2,594 | 1,170,523  | 585%                |
| Native MCP (minimal — required params only) | 2,594 | 244,047    | 122%                |
| Code mode                                   | 2     | 1,069      | 0.5%                |

## Get Started

MCP URL: `https://mcp.cloudflare.com/mcp`

### Option 1: OAuth (Recommended)

Just connect to the MCP server URL - you'll be redirected to Cloudflare to authorize and select permissions.

#### Example JSON Configuration

```json
{
  "mcpServers": {
    "cloudflare-api": {
      "url": "https://mcp.cloudflare.com/mcp"
    }
  }
}
```

### Option 2: API Token

For CI/CD, automation, or if you prefer managing tokens yourself.

Create a [Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens) with the permissions you need. Both **user tokens** and **account tokens** are supported. For account tokens, include the **Account Resources : Read** permission so the server can auto-detect your account ID.

### Add to Agent

MCP URL: `https://mcp.cloudflare.com/mcp`
Bearer Token: Your [Cloudflare API Token](https://dash.cloudflare.com/profile/api-tokens)

## The Problem

The Cloudflare OpenAPI spec is **2.3 million tokens** in JSON format. Even compressed to TypeScript endpoint summaries, it's still **~200k tokens**. Traditional MCP servers that expose every endpoint as a tool, or include the full spec in tool descriptions, leak this entire context to the main agent.

This server solves the problem by using **code execution** in a [codemode](https://blog.cloudflare.com/code-mode/) pattern - the spec lives on the server, and only the results of queries are returned to the agent.

## Tools

Agent writes code to search the spec and execute API calls.

| Tool      | Description                                                                   |
| --------- | ----------------------------------------------------------------------------- |
| `search`  | Write JavaScript to query `spec.paths` and find endpoints                     |
| `execute` | Write JavaScript to call `cloudflare.request()` with the discovered endpoints |

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

### GraphQL Analytics API

The server automatically detects and handles Cloudflare's GraphQL Analytics API endpoints. GraphQL queries work seamlessly through the same `execute` tool:

```javascript
execute({
  code: `async () => {
    const response = await cloudflare.request({
      method: "POST",
      path: "/client/v4/graphql",
      body: {
        query: \`query {
          viewer {
            zones(filter: { zoneTag: "\${accountId}" }) {
              httpRequests1dGroups(limit: 7, orderBy: [date_ASC]) {
                dimensions {
                  date
                }
                sum {
                  requests
                  bytes
                  cachedBytes
                }
              }
            }
          }
        }\`,
        variables: {}
      }
    });
    return response.result;
  }`,
  account_id: "your-account-id",
});
```

## Build a Code Mode MCP Server

Code execution uses Cloudflare's [Dynamic Worker Loader API](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) to run generated code in isolated Workers, following the [Code Mode pattern](https://github.com/cloudflare/agents/tree/main/packages/codemode).

Read the [Code Mode SDK docs](https://developers.cloudflare.com/agents/api-reference/codemode/) for more info.

### Resources

- [Code Mode blog post](https://blog.cloudflare.com/code-mode/)
- [Build your own remote MCP server](https://developers.cloudflare.com/agents/guides/remote-mcp-server/)
- [Cloudflare's own MCP Servers](https://github.com/cloudflare/mcp-server-cloudflare)

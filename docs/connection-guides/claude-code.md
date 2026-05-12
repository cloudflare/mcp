# Claude Code

Add the Cloudflare MCP server to Claude Code with a `.mcp.json` file.

## OAuth

For the hosted Cloudflare MCP server, add this configuration:

```json
{
  "mcpServers": {
    "cloudflare-api": {
      "type": "http",
      "url": "https://mcp.cloudflare.com/mcp"
    }
  }
}
```

Restart Claude Code after saving the file. Claude Code will connect over HTTP
and Cloudflare will prompt you to authorize access with OAuth.

## API Token

For automation or CI/CD workflows, create a
[Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens) with the
permissions your agent needs, then pass it as a bearer token:

```json
{
  "mcpServers": {
    "cloudflare-api": {
      "type": "http",
      "url": "https://mcp.cloudflare.com/mcp",
      "headers": {
        "Authorization": "Bearer ${CLOUDFLARE_API_TOKEN}"
      }
    }
  }
}
```

Both user tokens and account tokens are supported. For account tokens, include
the **Account Resources : Read** permission so the server can auto-detect your
account ID. Claude Code expands environment variables in `.mcp.json`, so keep
the token in your shell environment instead of committing the value to the file.

## Disable Code Mode

If you need each Cloudflare API endpoint exposed as an individual tool, add
`?codemode=false` to the URL:

```json
{
  "mcpServers": {
    "cloudflare-api": {
      "type": "http",
      "url": "https://mcp.cloudflare.com/mcp?codemode=false"
    }
  }
}
```

Only disable code mode when needed. It significantly increases the token cost
because the server registers thousands of endpoint-specific tools instead of
the compact code mode tools.

# Connecting with Claude Code

Claude Code supports two ways to add an MCP server.

## Option 1: CLI (recommended)

The quickest way to connect is the `claude mcp add` command:

```bash
claude mcp add --transport http cloudflare-api https://mcp.cloudflare.com/mcp
```

To connect with an API token instead of OAuth:

```bash
claude mcp add --transport http cloudflare-api https://mcp.cloudflare.com/mcp \
  --header "Authorization: Bearer YOUR_CLOUDFLARE_API_TOKEN"
```

This writes the configuration to your active `.mcp.json` automatically.

## Option 2: Manual JSON configuration

Add the following to your `.mcp.json` file (located in your project root or `~/.claude/.mcp.json` for global config):

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

> **Important:** The `"type": "http"` field is required. Without it, Claude Code defaults to `stdio` transport and the connection will fail.

To use an API token instead of OAuth, add the `Authorization` header:

```json
{
  "mcpServers": {
    "cloudflare-api": {
      "type": "http",
      "url": "https://mcp.cloudflare.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_CLOUDFLARE_API_TOKEN"
      }
    }
  }
}
```

## Verify the Connection

After connecting, restart Claude Code. You can verify the server is connected by asking Claude to list your Cloudflare Workers or any other Cloudflare resource.

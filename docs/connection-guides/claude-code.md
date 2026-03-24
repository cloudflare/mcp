# Connecting with Claude Code

## Configuration

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

## Using an API Token

If you prefer using an API token instead of OAuth, add the `Authorization` header:

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

After saving `.mcp.json`, restart Claude Code. You can verify the server is connected by asking Claude to list your Cloudflare Workers or any other Cloudflare resource.

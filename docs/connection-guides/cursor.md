# Cursor

Add the Cloudflare MCP server from Cursor Settings > MCP, or put this in `.cursor/mcp.json`:

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

`"type": "http"` is required. Cursor then opens Cloudflare so you can authorize and pick scopes.

## API token instead of OAuth

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

Create the token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens). Tokens with Client IP Address Filtering are not supported.
